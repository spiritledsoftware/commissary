// The Grants page's tool grants (src/lib/tool-grants.ts, #209, ADR 0038): drafts of each kind of grant (all, read, named
// tools) and what is wrong with them, the bodies they become, named tools by their current names with the vanished ones
// missing, and how the grants read by member, by team and by toolkit.
import { describe, expect, it } from "vitest";
import type { ToolGrant } from "@commissary/contract/grants";
import type { MemberView, TeamView } from "@commissary/contract/members";
import type { ToolkitView, ToolView } from "@commissary/contract/tools";
import {
  draftOfToolGrant,
  EMPTY_TOOL_GRANT_DRAFT,
  grantableToolkits,
  groupToolGrants,
  hasToolGrantErrors,
  namedTools,
  pickableTools,
  sameSelection,
  selectionLabel,
  toggledId,
  toolGrantBody,
  toolGrantProblem,
  ungrantedToolkits,
  validateToolGrant,
} from "../src/lib/tool-grants.ts";

const member = (id: string, teams: string[] = []): MemberView => ({
  id,
  email: `${id}@example.com`,
  role: "member",
  added_at: "2026-01-01T00:00:00Z",
  teams,
});

const team = (id: string): TeamView => ({
  id,
  name: id.toUpperCase(),
  created_at: "2026-01-01T00:00:00Z",
  members: [],
});

const directory = {
  members: [member("bob", ["research"]), member("alice")],
  teams: [team("research"), team("ops")],
};

const toolkit = (patch: Partial<ToolkitView>): ToolkitView => ({
  id: "tk_linear",
  kind: "mcp",
  name: "linear",
  source: "https://mcp.linear.app/mcp",
  private: false,
  accepts: "shared",
  revision: 1,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  updated_by: "user:admin@example.com",
  credentials: {},
  tool_list: { tools: 3 },
  ...patch,
});

const connected = {
  kind: "bearer" as const,
  connected_at: "2026-08-01T00:00:00.000Z",
  connected_by: "user:admin@example.com",
  active: true,
};

const toolkits = [
  toolkit({ id: "tk_linear", name: "linear", credentials: { shared: connected } }),
  toolkit({ id: "tk_github", name: "github", accepts: "both", credentials: { shared: connected } }),
  toolkit({ id: "tk_notes", name: "notes", private: true, accepts: "private" }),
  toolkit({ id: "tk_hubspot", name: "hubspot", accepts: "private" }),
  toolkit({ id: "tk_stripe", name: "stripe" }),
  toolkit({ id: "sandbox", kind: "sandbox", name: "sandbox", built_in: true }),
  // The agents toolkit takes no grant: a caller reaches it by running an agent.
  toolkit({ id: "agents", kind: "agents", name: "agents", built_in: true }),
];

let counter = 0;

const grant = (patch: Partial<ToolGrant>): ToolGrant => {
  counter += 1;

  return {
    id: `tg_${counter}`,
    subject: { kind: "everyone" },
    toolkit: "tk_linear",
    tools: { kind: "all" },
    revision: 1,
    updated_at: 1_700_000_000_000,
    updated_by: "ana@example.com",
    ...patch,
  };
};

const FLAGS = { shortened: false, renamed: false, hidden: false, clash: false, missing: false };

const tool = (upstream: string, patch: Partial<ToolView> = {}): ToolView => ({
  id: `tk_linear:${upstream}`,
  toolkit_id: "tk_linear",
  upstream_name: upstream,
  name: `linear_${upstream}`,
  class: "read",
  flags: FLAGS,
  ...patch,
});

describe("creating each kind of tool grant", () => {
  const base = { ...EMPTY_TOOL_GRANT_DRAFT, toolkit: "tk_linear" };

  it("gives a member all of a toolkit's tools", () => {
    const draft = { ...base, subjectKind: "member" as const, subjectId: "alice" };

    expect(validateToolGrant(draft, [])).toEqual({});
    expect(toolGrantBody(draft)).toEqual({
      subject: { kind: "member", id: "alice" },
      toolkit: "tk_linear",
      tools: { kind: "all" },
    });
  });

  it("gives a team the read tools", () => {
    const draft = {
      ...base,
      subjectKind: "team" as const,
      subjectId: "research",
      selection: "read" as const,
    };

    expect(validateToolGrant(draft, [])).toEqual({});
    expect(toolGrantBody(draft)).toEqual({
      subject: { kind: "team", id: "research" },
      toolkit: "tk_linear",
      tools: { kind: "read" },
    });
  });

  it("gives everyone named tools, de-duplicated and sorted as the server keeps them", () => {
    const draft = {
      ...base,
      subjectKind: "everyone" as const,
      selection: "named" as const,
      ids: ["tk_linear:get_issue", "tk_linear:create_issue", "tk_linear:get_issue"],
    };

    expect(validateToolGrant(draft, [])).toEqual({});
    expect(toolGrantBody(draft)).toEqual({
      subject: { kind: "everyone" },
      toolkit: "tk_linear",
      tools: { kind: "named", ids: ["tk_linear:create_issue", "tk_linear:get_issue"] },
    });
  });

  it("asks for what is missing", () => {
    expect(validateToolGrant(EMPTY_TOOL_GRANT_DRAFT, [])).toEqual({
      subject: "Choose a member.",
      toolkit: "Choose a toolkit.",
    });
    expect(validateToolGrant({ ...EMPTY_TOOL_GRANT_DRAFT, subjectKind: "team" }, []).subject).toBe(
      "Choose a team.",
    );

    const named = { ...base, subjectKind: "everyone" as const, selection: "named" as const };

    expect(validateToolGrant(named, []).tools).toContain("Pick at least one tool");
    expect(hasToolGrantErrors(validateToolGrant(named, []))).toBe(true);
    expect(hasToolGrantErrors(validateToolGrant({ ...named, selection: "all" }, []))).toBe(false);
  });

  it("refuses a selection the subject holds already, as the server does, but lets a different one through", () => {
    const held = grant({ subject: { kind: "member", id: "alice" }, tools: { kind: "read" } });

    const draft = {
      ...base,
      subjectKind: "member" as const,
      subjectId: "alice",
      selection: "read" as const,
    };

    expect(validateToolGrant(draft, [held]).tools).toContain("already holds");
    // Editing that grant is not a clash with itself.
    expect(validateToolGrant(draft, [held], held)).toEqual({});
    // Another selection, another toolkit or another subject is its own grant.
    expect(validateToolGrant({ ...draft, selection: "all" }, [held])).toEqual({});
    expect(validateToolGrant({ ...draft, toolkit: "tk_github" }, [held])).toEqual({});
    expect(validateToolGrant({ ...draft, subjectId: "bob" }, [held])).toEqual({});

    const named = grant({
      subject: { kind: "member", id: "alice" },
      tools: { kind: "named", ids: ["tk_linear:a", "tk_linear:b"] },
    });

    // One set of named tools is one selection, whatever its order.
    expect(
      validateToolGrant({ ...draft, selection: "named", ids: ["tk_linear:b", "tk_linear:a"] }, [
        named,
      ]).tools,
    ).toContain("already holds");
    expect(
      validateToolGrant({ ...draft, selection: "named", ids: ["tk_linear:a"] }, [named]),
    ).toEqual({});
  });

  it("fills the form from a grant being edited", () => {
    expect(
      draftOfToolGrant(
        grant({
          subject: { kind: "team", id: "ops" },
          toolkit: "tk_github",
          tools: { kind: "named", ids: ["tk_github:x"] },
        }),
      ),
    ).toEqual({
      subjectKind: "team",
      subjectId: "ops",
      toolkit: "tk_github",
      selection: "named",
      ids: ["tk_github:x"],
    });
  });

  it("compares selections by kind and, for named tools, by the set", () => {
    expect(sameSelection({ kind: "all" }, { kind: "all" })).toBe(true);
    expect(sameSelection({ kind: "all" }, { kind: "read" })).toBe(false);
    expect(sameSelection({ kind: "named", ids: ["a"] }, { kind: "named", ids: ["a", "a"] })).toBe(
      true,
    );
    expect(sameSelection({ kind: "named", ids: ["a"] }, { kind: "named", ids: ["b"] })).toBe(false);
  });

  it("explains a refused write", () => {
    expect(toolGrantProblem("conflict", "x")).toContain("Reload");
    expect(toolGrantProblem("invalid", "a grant names the toolkit")).toBe(
      "A grant names the toolkit.",
    );
    expect(toolGrantProblem("other", "plain")).toBe("plain");
  });
});

describe("the toolkits a grant may name", () => {
  it("are the org's own that take a shared credential, the built-in ones, but not the agents toolkit", () => {
    expect(grantableToolkits(toolkits).map((each) => each.name)).toEqual([
      "github",
      "linear",
      "sandbox",
      "stripe",
    ]);
  });

  it("flag those that hold a shared credential or are built in and no grant reaches, never the agents toolkit", () => {
    const grants = [grant({ toolkit: "tk_github" })];

    expect(ungrantedToolkits(toolkits, grants).map((each) => each.name)).toEqual([
      "linear",
      "sandbox",
    ]);
    expect(ungrantedToolkits(toolkits, []).map((each) => each.name)).toEqual([
      "github",
      "linear",
      "sandbox",
    ]);
  });
});

describe("named tools", () => {
  const listed = [
    tool("create_issue", { name: "linear_open_issue", flags: { ...FLAGS, renamed: true } }),
    tool("get_issue"),
    tool("update_cycle", { flags: { ...FLAGS, missing: true } }),
  ];

  it("read by their current names, so a renamed tool shows its new name", () => {
    const named = namedTools(
      grant({ tools: { kind: "named", ids: ["tk_linear:get_issue", "tk_linear:create_issue"] } }),
      listed,
    );

    expect(named).toEqual([
      { id: "tk_linear:get_issue", name: "linear_get_issue", missing: false },
      { id: "tk_linear:create_issue", name: "linear_open_issue", missing: false },
    ]);
  });

  it("mark a tool the list no longer has as missing, by what the server says or what the list shows", () => {
    const given = grant({
      tools: {
        kind: "named",
        ids: ["tk_linear:get_issue", "tk_linear:delete_issue", "tk_linear:update_cycle"],
      },
      missing: ["tk_linear:delete_issue"],
    });

    expect(namedTools(given, listed).filter((each) => each.missing)).toEqual([
      { id: "tk_linear:delete_issue", name: "delete_issue", missing: true },
      { id: "tk_linear:update_cycle", name: "update_cycle", missing: true },
    ]);
    // Before the list is read, only the server's word counts.
    expect(
      namedTools(given, undefined)
        .filter((each) => each.missing)
        .map((each) => each.id),
    ).toEqual(["tk_linear:delete_issue"]);
    expect(namedTools(grant({ tools: { kind: "all" } }), listed)).toEqual([]);
  });

  it("say what a selection gives in a table cell", () => {
    expect(selectionLabel({ kind: "all" })).toBe("All tools");
    expect(selectionLabel({ kind: "read" })).toBe("Read tools");
    expect(selectionLabel({ kind: "named", ids: ["a"] })).toBe("1 named tool");
    expect(selectionLabel({ kind: "named", ids: ["a", "b"] })).toBe("2 named tools");
  });

  it("are picked from the list: not the ones gone upstream, narrowed by a search", () => {
    // By full name: linear_get_issue before linear_open_issue (create_issue, renamed).
    expect(pickableTools(listed, "").map((each) => each.id)).toEqual([
      "tk_linear:get_issue",
      "tk_linear:create_issue",
    ]);
    expect(pickableTools(listed, "OPEN").map((each) => each.id)).toEqual([
      "tk_linear:create_issue",
    ]);
    expect(toggledId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggledId(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("reading the grants", () => {
  const grants = [
    grant({
      id: "g1",
      subject: { kind: "everyone" },
      toolkit: "tk_linear",
      tools: { kind: "read" },
    }),
    grant({
      id: "g2",
      subject: { kind: "team", id: "research" },
      toolkit: "tk_github",
      tools: { kind: "all" },
    }),
    grant({
      id: "g3",
      subject: { kind: "member", id: "alice" },
      toolkit: "tk_github",
      tools: { kind: "named", ids: ["tk_github:a"] },
    }),
  ];

  const ids = (groups: ReturnType<typeof groupToolGrants>) =>
    groups.map((group) => [group.label, group.grants.map((each) => each.id)]);

  it("by member: what reaches each member, through their own grants, their teams' and everyone's", () => {
    expect(ids(groupToolGrants(grants, "member", directory, toolkits))).toEqual([
      ["alice@example.com", ["g1", "g3"]],
      ["bob@example.com", ["g1", "g2"]],
    ]);
  });

  it("by team: what each team and everyone is given", () => {
    expect(ids(groupToolGrants(grants, "team", directory, toolkits))).toEqual([
      ["Everyone", ["g1"]],
      ["OPS", []],
      ["RESEARCH", ["g2"]],
    ]);
  });

  it("by toolkit: who may use each toolkit's shared credential", () => {
    expect(ids(groupToolGrants(grants, "toolkit", directory, toolkits))).toEqual([
      ["github", ["g2", "g3"]],
      ["linear", ["g1"]],
    ]);
  });
});
