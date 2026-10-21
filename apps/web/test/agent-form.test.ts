// The agent editor's model (src/lib/agent-form.ts, #233, ADR 0040, ADR 0041): drafts, what is wrong with them, the
// body a draft becomes on creation, the patch it becomes on an edit, the tool scope with its agents, and the sandbox.
import { describe, expect, it } from "vitest";
import type { AgentView } from "@commissary/contract/agents";
import type { ToolkitView } from "@commissary/contract/tools";
import {
  addWatcher,
  sandboxCeilingText,
  subjectOfPick,
  createBody,
  draftOfAgent,
  EMPTY_DRAFT,
  hasChanges,
  hasErrors,
  NO_SANDBOX,
  networkAllowed,
  nameProblem,
  removeWatcher,
  sandboxCeiling,
  sandboxOf,
  sandboxScopeNote,
  sandboxProblem,
  sandboxToolkits,
  scopeOfAgentDraft,
  updatePatch,
  validateDraft,
} from "../src/lib/agent-form.ts";

const T = "2026-08-12T10:00:00.000Z";

const AGENT: AgentView = {
  id: "ag_1",
  name: "digest",
  description: "A daily digest",
  instructions: "Summarise the day.",
  model: "claude-sonnet-4",
  thinking: "high",
  tool_scope: [
    { toolkit: "tk_gh", tools: { kind: "read" } },
    { toolkit: "tk_lin", tools: { kind: "named", ids: ["tk_lin:create_issue"] } },
    { toolkit: "agents", tools: { kind: "all" }, agents: ["ag_2"] },
  ],
  sandbox: { toolkit: "sandbox", network: { kind: "none" } },
  enabled: true,
  private: false,
  watchers: [{ kind: "member", id: "m1" }],
  revision: 3,
  created_at: T,
  updated_at: T,
};

const filled = {
  ...EMPTY_DRAFT,
  name: "digest",
  model: "claude-sonnet-4",
};

describe("a draft's problems", () => {
  it("needs a name of lowercase letters, digits and underscores, and a model", () => {
    expect(validateDraft(EMPTY_DRAFT, { shared: false, creating: true })).toEqual({
      name: "An agent needs a name.",
      model: "Pick the model the agent runs on.",
    });

    expect(nameProblem("Daily Digest")).toContain("lowercase");
    expect(nameProblem("daily_digest_2")).toBeUndefined();
    expect(nameProblem("x".repeat(65))).toContain("1 to 64");
    expect(hasErrors(validateDraft(filled, { shared: false, creating: true }))).toBe(false);
  });

  it("limits the texts the server limits", () => {
    const errors = validateDraft(
      { ...filled, description: "d".repeat(1_001), instructions: "i".repeat(65_537) },
      { shared: false, creating: false },
    );

    expect(errors.description).toContain("1,000");
    expect(errors.instructions).toContain("65,536");
  });

  it("blocks creating a shared agent without a grant, and a grant that names no one", () => {
    expect(validateDraft(filled, { shared: true, creating: true }).subject).toContain("no default");

    expect(
      validateDraft({ ...filled, subjectKind: "team" }, { shared: true, creating: true }).subject,
    ).toBe("Choose the team.");

    expect(
      validateDraft({ ...filled, subjectKind: "member" }, { shared: true, creating: true }).subject,
    ).toBe("Choose the member.");

    expect(
      hasErrors(
        validateDraft(
          { ...filled, subjectKind: "team", subjectId: "t1" },
          { shared: true, creating: true },
        ),
      ),
    ).toBe(false);

    expect(
      hasErrors(
        validateDraft({ ...filled, subjectKind: "everyone" }, { shared: true, creating: true }),
      ),
    ).toBe(false);

    // Editing a shared agent does not ask for a grant: they are managed on its page.
    expect(validateDraft(filled, { shared: true, creating: false }).subject).toBeUndefined();
    // A private agent has none.
    expect(validateDraft(filled, { shared: false, creating: true }).subject).toBeUndefined();
  });

  it("reads an optional spend limit as dollars", () => {
    const shared = { shared: true, creating: true } as const;
    const base = { ...filled, subjectKind: "everyone" } as const;

    expect(validateDraft({ ...base, limitAmount: "25" }, shared).limit).toBeUndefined();
    expect(validateDraft({ ...base, limitAmount: "twenty" }, shared).limit).toContain("US dollars");
    expect(validateDraft({ ...base, limitAmount: "" }, shared).limit).toBeUndefined();
  });

  it("wants the agents it may run picked when it is limited to some", () => {
    const limited = { ...draftOfAgent(AGENT), agents: { limited: true, ids: [] } };

    expect(validateDraft(limited, { shared: false, creating: true }).scope).toContain(
      "Pick the agents",
    );
  });

  it("asks for those agents only while the agents toolkit is in its scope", () => {
    expect(
      validateDraft(
        { ...filled, agents: { limited: true, ids: [] } },
        { shared: false, creating: true },
      ).scope,
    ).toBeUndefined();
  });
});

describe("the tool scope", () => {
  it("is the editor's toolkits, with the agents the agents toolkit may run", () => {
    expect(scopeOfAgentDraft(draftOfAgent(AGENT))).toEqual(AGENT.tool_scope);
  });

  it("is none for a new agent: `[]` gives no tools", () => {
    expect(scopeOfAgentDraft(EMPTY_DRAFT)).toEqual([]);
  });

  it("names agents only while limited to some, and only on the agents toolkit's entry", () => {
    const draft = draftOfAgent(AGENT);

    expect(
      scopeOfAgentDraft({ ...draft, agents: { limited: false, ids: ["ag_2"] } }).find(
        (entry) => entry.toolkit === "agents",
      ),
    ).toEqual({ toolkit: "agents", tools: { kind: "all" } });

    expect(scopeOfAgentDraft(draft).find((entry) => entry.toolkit === "tk_gh")).toEqual({
      toolkit: "tk_gh",
      tools: { kind: "read" },
    });
  });
});

describe("the body of a new agent", () => {
  it("is a private agent's: its definition and no grant", () => {
    expect(
      createBody(
        { ...filled, description: " A digest ", thinking: "low", instructions: "Go." },
        false,
      ),
    ).toEqual({
      name: "digest",
      description: "A digest",
      instructions: "Go.",
      model: "claude-sonnet-4",
      thinking: "low",
      tool_scope: [],
      private: true,
    });
  });

  it("is a shared agent's: who may use it and its watchers", () => {
    const body = createBody(
      {
        ...filled,
        subjectKind: "team",
        subjectId: "t1",
        watchers: [{ kind: "member", id: "m1" }],
      },
      true,
    );

    expect(body).toMatchObject({
      private: false,
      subject: { kind: "team", id: "t1" },
      watchers: [{ kind: "member", id: "m1" }],
    });

    expect(createBody({ ...filled, subjectKind: "everyone" }, true).subject).toEqual({
      kind: "everyone",
    });
    expect(
      createBody({ ...filled, subjectKind: "team", subjectId: "t1" }, false),
    ).not.toHaveProperty("subject");
  });

  it("carries the sandbox it asks for", () => {
    const body = createBody(
      {
        ...filled,
        sandbox: {
          on: true,
          toolkit: "sandbox",
          network: "hosts",
          hosts: "Example.com\n*.npmjs.org",
          registries: true,
          computer: true,
        },
      },
      false,
    );

    expect(body.sandbox).toEqual({
      toolkit: "sandbox",
      network: {
        kind: "hosts",
        hosts: ["example.com", "*.npmjs.org"],
        presets: ["package_registries"],
      },
      computer: true,
    });
  });
});

describe("who a grant names", () => {
  it("names everyone without an id, and a team or member once one is picked", () => {
    expect(subjectOfPick("everyone", "")).toEqual({ kind: "everyone" });
    expect(subjectOfPick("team", "t1")).toEqual({ kind: "team", id: "t1" });
    expect(subjectOfPick("member", "")).toBeUndefined();
    expect(subjectOfPick("", "t1")).toBeUndefined();
  });
});

describe("an edit", () => {
  it("sends nothing while nothing changed", () => {
    expect(hasChanges(updatePatch(AGENT, draftOfAgent(AGENT)))).toBe(false);
  });

  it("sends only the fields that changed", () => {
    const draft = draftOfAgent(AGENT);

    expect(updatePatch(AGENT, { ...draft, name: "daily", model: "gpt-5", enabled: false })).toEqual(
      { name: "daily", model: "gpt-5", enabled: false },
    );

    expect(updatePatch(AGENT, { ...draft, instructions: "Be brief." })).toEqual({
      instructions: "Be brief.",
    });
  });

  it("clears the thinking level and the sandbox with null", () => {
    const draft = draftOfAgent(AGENT);

    expect(
      updatePatch(AGENT, { ...draft, thinking: "", sandbox: { ...draft.sandbox, on: false } }),
    ).toEqual({ thinking: null, sandbox: null });
  });

  it("sends the scope whole when a toolkit's choice changed", () => {
    const draft = draftOfAgent(AGENT);

    const patch = updatePatch(AGENT, {
      ...draft,
      scope: { ...draft.scope, picks: { ...draft.scope.picks, tk_gh: { choice: "all", ids: [] } } },
    });

    expect(patch.tool_scope).toEqual([
      { toolkit: "tk_gh", tools: { kind: "all" } },
      AGENT.tool_scope[1],
      AGENT.tool_scope[2],
    ]);
  });

  it("sends watchers of a shared agent only when they changed, whatever their order", () => {
    const two = {
      ...AGENT,
      watchers: [
        { kind: "member", id: "m1" },
        { kind: "team", id: "t1" },
      ],
    } as const;

    const draft = draftOfAgent(two);

    expect(updatePatch(two, { ...draft, watchers: [...draft.watchers].reverse() })).toEqual({});
    expect(updatePatch(two, { ...draft, watchers: [] })).toEqual({ watchers: [] });
    // A private agent has no watchers to send.
    expect(updatePatch({ ...two, private: true }, { ...draft, watchers: [] })).toEqual({});
  });

  it("adds and removes watchers once each", () => {
    const one = addWatcher([], { kind: "team", id: "t1" });

    expect(addWatcher(one, { kind: "team", id: "t1" })).toEqual(one);
    expect(addWatcher(one, { kind: "member", id: "t1" })).toHaveLength(2);
    expect(removeWatcher(one, { kind: "team", id: "t1" })).toEqual([]);
  });
});

describe("the sandbox", () => {
  const toolkit = (over: Partial<ToolkitView>): ToolkitView =>
    // SAFETY: the sandbox part reads only a toolkit's kind and its ceiling.
    ({ id: "sandbox", kind: "sandbox", name: "sandbox", ...over }) as ToolkitView;

  it("offers the sandbox toolkits among the toolkits", () => {
    expect(
      sandboxToolkits([toolkit({}), toolkit({ id: "tk_gh", kind: "mcp" })]).map((each) => each.id),
    ).toEqual(["sandbox"]);
  });

  it("takes the ceiling from the toolkit the draft names, else the only sandbox toolkit", () => {
    const wide = toolkit({ id: "wide", network: { kind: "open" } });
    const narrow = toolkit({ id: "narrow" });

    expect(sandboxCeiling([narrow, wide], { ...NO_SANDBOX, on: true, toolkit: "wide" })).toBe(wide);
    expect(sandboxCeiling([narrow], NO_SANDBOX)).toBe(narrow);
    expect(sandboxCeiling([toolkit({ id: "gh", kind: "mcp" })], NO_SANDBOX)).toBeUndefined();
  });

  it("sends no sandbox edit for one that differs only in what it leaves out", () => {
    const left = { ...AGENT, sandbox: { toolkit: "sandbox" } };

    const draft = draftOfAgent({
      ...AGENT,
      sandbox: { toolkit: "sandbox", network: { kind: "none" }, computer: false },
    });

    expect(updatePatch(left, draft)).toEqual({});
    expect(updatePatch(left, { ...draft, sandbox: { ...draft.sandbox, computer: true } })).toEqual({
      sandbox: { toolkit: "sandbox", network: { kind: "none" }, computer: true },
    });
  });

  it("asks for no sandbox when it is off, and for no network by default", () => {
    const { sandbox: _sandbox, ...withoutSandbox } = AGENT;

    expect(sandboxOf(draftOfAgent(withoutSandbox).sandbox)).toBeUndefined();

    expect(
      sandboxOf({
        on: true,
        toolkit: "sandbox",
        network: "none",
        hosts: "",
        registries: false,
        computer: false,
      }),
    ).toEqual({
      toolkit: "sandbox",
      network: { kind: "none" },
    });
  });

  it("stays within the toolkit's ceiling: no wider a network, no computer it does not allow", () => {
    const base = {
      on: true,
      toolkit: "sandbox",
      network: "none",
      hosts: "",
      registries: false,
      computer: false,
    } as const;

    expect(networkAllowed("none", undefined)).toBe(true);
    expect(networkAllowed("hosts", undefined)).toBe(false);
    expect(networkAllowed("hosts", { kind: "hosts", hosts: ["a.com"] })).toBe(true);
    expect(networkAllowed("open", { kind: "hosts", hosts: ["a.com"] })).toBe(false);
    expect(networkAllowed("open", { kind: "open" })).toBe(true);

    expect(sandboxProblem({ ...base, network: "open" }, { network: { kind: "none" } })).toBe(
      "The sandbox toolkit allows no network and no computer.",
    );

    expect(
      sandboxProblem({ ...base, computer: true }, { network: { kind: "none" }, computer: false }),
    ).toBe("The sandbox toolkit does not allow the computer.");

    expect(
      sandboxProblem({ ...base, computer: true }, { network: { kind: "none" }, computer: true }),
    ).toBeUndefined();
    expect(sandboxCeilingText({ network: { kind: "open" }, computer: true })).toBe(
      "the internet and the computer",
    );
  });

  it("notes a sandbox whose tools the scope does not give", () => {
    const draft = draftOfAgent(AGENT);

    expect(sandboxScopeNote(draft)).toContain("none of this toolkit's tools");

    expect(
      sandboxScopeNote({
        ...draft,
        scope: {
          ...draft.scope,
          picks: { ...draft.scope.picks, sandbox: { choice: "all", ids: [] } },
        },
      }),
    ).toBeUndefined();

    expect(
      sandboxScopeNote({ ...draft, sandbox: { ...draft.sandbox, on: false } }),
    ).toBeUndefined();
  });

  it("wants a toolkit and, for a list of hosts, well-formed host names", () => {
    const base = {
      on: true,
      toolkit: "",
      network: "hosts",
      hosts: "",
      registries: false,
      computer: false,
    } as const;

    expect(sandboxProblem(base)).toContain("Pick the sandbox toolkit");
    expect(sandboxProblem({ ...base, toolkit: "sandbox" })).toContain("Name a host");
    expect(sandboxProblem({ ...base, toolkit: "sandbox", registries: true })).toBeUndefined();
    expect(sandboxProblem({ ...base, toolkit: "sandbox", hosts: "https://a.com" })).toContain(
      "not a host name",
    );
    expect(
      sandboxProblem({ ...base, toolkit: "sandbox", hosts: "a.com, *.b.org" }),
    ).toBeUndefined();
    expect(sandboxProblem({ ...base, on: false })).toBeUndefined();
  });
});
