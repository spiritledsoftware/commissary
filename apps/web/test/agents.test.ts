// The Agents pages' model (src/lib/agents.ts, #233, ADR 0040): who may create which agents, the list and its order, what
// an org admin sees of other members' private agents, and what a refused write says.
import { describe, expect, it } from "vitest";
import type { AgentView, LimitedAgentView, UsableAgent } from "@commissary/contract/agents";
import {
  agentProblem,
  agentsCallerOf,
  canCreateAgent,
  canCreatePrivate,
  canCreateShared,
  emptyAgentsText,
  modelText,
  otherAgentRows,
  privateOffText,
  problemField,
  scopeText,
  sharedWithCaller,
  sortAgents,
  thinkingOf,
} from "../src/lib/agents.ts";

const T = "2026-08-12T10:00:00.000Z";

const agent = (over: Partial<AgentView> & { id: string; name: string }): AgentView => ({
  description: "",
  instructions: "",
  model: "claude-sonnet-4",
  tool_scope: [],
  enabled: true,
  private: true,
  revision: 1,
  created_at: T,
  updated_at: T,
  ...over,
});

describe("who may create agents", () => {
  it("lets an org admin create shared agents, and anyone private ones where the org allows them", () => {
    const admin = agentsCallerOf({ role: "admin", platform_admin: false, private_agents: false });
    const member = agentsCallerOf({ role: "member", platform_admin: false, private_agents: true });
    const closed = agentsCallerOf({ role: "member", platform_admin: false });

    expect(canCreateShared(admin)).toBe(true);
    expect(canCreatePrivate(admin)).toBe(false);
    expect(canCreateAgent(admin)).toBe(true);
    expect(canCreateAgent(member)).toBe(true);
    expect(canCreateShared(member)).toBe(false);
    expect(canCreatePrivate(member)).toBe(true);
    expect(canCreateAgent(closed)).toBe(false);
  });

  it("reads a platform admin without a role as an owner", () => {
    expect(agentsCallerOf({ role: null, platform_admin: true }).admin).toBe(true);
  });

  it("says why the list is empty, and when private agents are off", () => {
    expect(emptyAgentsText({ admin: true, privateAgents: false })).toContain("shared agent");
    expect(emptyAgentsText({ admin: false, privateAgents: true })).toContain("private one");
    expect(emptyAgentsText({ admin: false, privateAgents: false })).toContain("org admin");
    expect(privateOffText({ admin: false, privateAgents: true })).toBeUndefined();
    expect(privateOffText({ admin: true, privateAgents: false })).toContain("Members page");
    expect(privateOffText({ admin: false, privateAgents: false })).toContain("none runs");
  });
});

describe("the list", () => {
  it("lists enabled agents first, then by name", () => {
    const sorted = sortAgents([
      agent({ id: "3", name: "zeta" }),
      agent({ id: "2", name: "alpha", enabled: false }),
      agent({ id: "1", name: "beta" }),
    ]);

    expect(sorted.map((each) => each.name)).toEqual(["beta", "zeta", "alpha"]);
  });

  it("says the model with its thinking level, and the tool scope in toolkits", () => {
    expect(modelText(agent({ id: "1", name: "a" }))).toBe("claude-sonnet-4");
    expect(modelText(agent({ id: "1", name: "a", thinking: "none" }))).toBe("claude-sonnet-4");
    expect(modelText(agent({ id: "1", name: "a", thinking: "xhigh" }))).toBe(
      "claude-sonnet-4, thinking extra high",
    );
    expect(scopeText(agent({ id: "1", name: "a" }))).toBe("No tools");

    expect(
      scopeText(
        agent({ id: "1", name: "a", tool_scope: [{ toolkit: "gh", tools: { kind: "all" } }] }),
      ),
    ).toBe("1 toolkit");

    expect(
      scopeText(
        agent({
          id: "1",
          name: "a",
          tool_scope: [
            { toolkit: "gh", tools: { kind: "all" } },
            { toolkit: "lin", tools: { kind: "read" } },
          ],
        }),
      ),
    ).toBe("2 toolkits");
  });

  it("adds the shared agents a member may use but does not manage", () => {
    const managed = [agent({ id: "own", name: "mine" })];

    const usable: ReadonlyArray<UsableAgent> = [
      { id: "own", name: "mine", description: "", private: true },
      { id: "sh2", name: "triage", description: "Triage issues", private: false },
      { id: "sh1", name: "digest", description: "A digest", private: false },
    ];

    expect(sharedWithCaller(managed, usable).map((each) => each.name)).toEqual([
      "digest",
      "triage",
    ]);
    // An org admin manages the shared agent already: it is not listed twice.
    expect(
      sharedWithCaller([agent({ id: "sh1", name: "digest", private: false })], usable),
    ).toHaveLength(1);
  });

  it("shows another member's private agent as its name, owner and state, nothing more", () => {
    const others: ReadonlyArray<LimitedAgentView> = [
      {
        id: "x2",
        name: "scratch",
        private: true,
        limited: true,
        owner: { member_id: "m3" },
        enabled: true,
        created_at: T,
        revision: 4,
      },
      {
        id: "x1",
        name: "notes",
        private: true,
        limited: true,
        owner: { member_id: "m2", email: "bo@acme.dev" },
        enabled: false,
        created_at: T,
        revision: 2,
      },
    ];

    const rows = otherAgentRows(others);

    expect(rows.map((row) => [row.name, row.owner, row.enabled, row.revision])).toEqual([
      ["notes", "bo@acme.dev", false, 2],
      ["scratch", "m3", true, 4],
    ]);
  });

  it("reads a picker's value as a thinking level, or not at all", () => {
    expect(thinkingOf("high")).toBe("high");
    expect(thinkingOf("loud")).toBeUndefined();
  });
});

describe("refused writes", () => {
  it("explains each code the agents routes answer", () => {
    expect(agentProblem("name_taken", "x")).toContain("Another agent");
    expect(agentProblem("unknown_model", "x")).toContain("in reach");
    expect(agentProblem("private_agents_unavailable", "x")).toContain("Members page");
    expect(agentProblem("conflict", "x")).toContain("Reload");
    expect(
      agentProblem("invalid_sandbox", "x", "the sandbox toolkit allows at most no network"),
    ).toBe("The sandbox toolkit allows at most no network.");
    expect(agentProblem("invalid", "an agent's name is wrong", "an agent's name is 1 to 64")).toBe(
      "An agent's name is 1 to 64.",
    );
    expect(agentProblem("something_new", "the server said so")).toBe("the server said so");
  });

  it("points a refusal at the field it is about", () => {
    expect(problemField("name_taken", undefined)).toBe("name");
    expect(problemField("unknown_model", "model")).toBe("model");
    expect(problemField("unknown_toolkit", "tool_scope")).toBe("scope");
    expect(problemField("invalid_sandbox", "sandbox")).toBe("sandbox");
    expect(problemField("conflict", undefined)).toBeUndefined();
  });
});
