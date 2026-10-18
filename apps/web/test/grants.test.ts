// The Grants page's model (src/lib/grants.ts): drafts and their validation, the body a draft becomes, and how grants
// read by member, by team and by credential.
import { describe, expect, it } from "@effect/vitest";
import type { Grant } from "@commissary/contract/grants";
import type { MemberView, TeamView } from "@commissary/contract/members";
import {
  draftOf,
  filterMyModels,
  EMPTY_GRANT_DRAFT,
  givesEveryModel,
  GRANT_PROVIDERS,
  grantBody,
  grantProblem,
  groupGrants,
  hasGrantErrors,
  modelsNote,
  parsePatterns,
  scopeLabel,
  sortGrants,
  subjectLabel,
  validateGrant,
} from "../src/lib/grants.ts";
import { providerName } from "../src/lib/providers.ts";

const member = (id: string, teams: string[] = []): MemberView => ({
  id,
  email: `${id}@example.com`,
  role: "member",
  added_at: "2026-01-01T00:00:00Z",
  teams,
});

const team = (id: string, members: string[] = []): TeamView => ({
  id,
  name: id.toUpperCase(),
  created_at: "2026-01-01T00:00:00Z",
  members,
});

const directory = {
  members: [member("bob", ["research"]), member("alice")],
  teams: [team("research", ["bob"]), team("ops")],
};

let counter = 0;

const grant = (patch: Partial<Grant>): Grant => {
  counter += 1;

  return {
    id: `grant-${counter}`,
    subject: { kind: "everyone" },
    scope: { kind: "all" },
    models: ["*"],
    revision: 1,
    updated_at: 1_700_000_000_000,
    updated_by: "ian@example.com",
    ...patch,
  };
};

describe("model patterns", () => {
  it("are split on commas, spaces and lines, lower-cased and de-duplicated", () => {
    expect(parsePatterns(" Claude-Sonnet-*,\n gpt-5  claude-sonnet-* ,, ")).toEqual([
      "claude-sonnet-*",
      "gpt-5",
    ]);
    expect(parsePatterns("  ,\n")).toEqual([]);
  });
});

describe("the body of a draft", () => {
  it("names the subject, the scope and the patterns", () => {
    expect(
      grantBody({
        subjectKind: "team",
        subjectId: " research ",
        scopeKind: "provider",
        scopeValue: " Claude ",
        models: "Claude-Sonnet-*",
      }),
    ).toEqual({
      subject: { kind: "team", id: "research" },
      scope: { kind: "provider", provider: "claude" },
      models: ["claude-sonnet-*"],
    });

    expect(grantBody({ ...EMPTY_GRANT_DRAFT, subjectKind: "everyone", models: "*" })).toEqual({
      subject: { kind: "everyone" },
      scope: { kind: "all" },
      models: ["*"],
    });
  });

  it("scopes a grant to a System One provider, named in the panel", () => {
    expect(GRANT_PROVIDERS).toEqual(expect.arrayContaining(["typesafe", "subq"]));
    expect([providerName("typesafe"), providerName("subq")]).toEqual(["TypeSafe", "SubQ"]);
    expect(
      grantBody({
        ...EMPTY_GRANT_DRAFT,
        subjectKind: "everyone",
        scopeKind: "provider",
        scopeValue: "typesafe",
        models: "jev-*",
      }),
    ).toEqual({
      subject: { kind: "everyone" },
      scope: { kind: "provider", provider: "typesafe" },
      models: ["jev-*"],
    });
  });

  it("round-trips through the form's fields", () => {
    const existing = grant({
      subject: { kind: "member", id: "alice" },
      scope: { kind: "credential", id: "work.json" },
      models: ["claude-sonnet-*", "gpt-5"],
    });

    expect(grantBody(draftOf(existing))).toEqual({
      subject: existing.subject,
      scope: existing.scope,
      models: existing.models,
    });
  });
});

describe("validating a draft", () => {
  const filled = { ...EMPTY_GRANT_DRAFT, subjectId: "alice", models: "claude-sonnet-*" };

  it("accepts a complete draft", () => {
    expect(hasGrantErrors(validateGrant(filled, []))).toBe(false);
  });

  it("asks for what is missing", () => {
    expect(validateGrant({ ...filled, subjectId: "" }, [])).toEqual({
      subject: "Choose a member.",
    });
    expect(validateGrant({ ...filled, subjectKind: "team", subjectId: "" }, [])).toEqual({
      subject: "Choose a team.",
    });
    expect(validateGrant({ ...filled, scopeKind: "provider" }, [])).toEqual({
      scope: "Name the provider.",
    });
    expect(validateGrant({ ...filled, scopeKind: "credential" }, [])).toEqual({
      scope: "Choose an account.",
    });
    expect(validateGrant({ ...filled, models: " , " }, [])).toEqual({
      models: "Name at least one model, or * for every model.",
    });
  });

  it("refuses a second grant for the same subject and scope, except when editing that one", () => {
    const existing = grant({ subject: { kind: "member", id: "alice" }, scope: { kind: "all" } });

    expect(validateGrant(filled, [existing]).subject).toMatch(/already has a grant/);
    expect(hasGrantErrors(validateGrant(filled, [existing], existing))).toBe(false);

    expect(
      hasGrantErrors(
        validateGrant({ ...filled, scopeKind: "provider", scopeValue: "claude" }, [existing]),
      ),
    ).toBe(false);
  });
});

describe("what a refused write says", () => {
  it("tells a stale edit to reload, and passes the server's reason for a refused grant", () => {
    expect(grantProblem("conflict", "x")).toMatch(/Reload/);
    expect(grantProblem("invalid_config", "no such member")).toBe("No such member.");
    expect(grantProblem(undefined, "boom")).toBe("boom");
  });
});

describe("labels and order", () => {
  it("name members and teams, falling back to the id of one that is gone", () => {
    expect(subjectLabel({ kind: "everyone" }, directory)).toBe("Everyone");
    expect(subjectLabel({ kind: "member", id: "alice" }, directory)).toBe("alice@example.com");
    expect(subjectLabel({ kind: "team", id: "research" }, directory)).toBe("RESEARCH");
    expect(subjectLabel({ kind: "member", id: "gone" }, directory)).toBe("gone");

    expect(scopeLabel({ kind: "all" })).toBe("All shared credentials");
    expect(scopeLabel({ kind: "provider", provider: "claude" })).toBe("Every claude account");
    expect(scopeLabel({ kind: "credential", id: "work.json" })).toBe("work.json");
  });

  it("sort everyone first, then teams, then members", () => {
    const everyone = grant({});
    const ops = grant({ subject: { kind: "team", id: "ops" } });
    const alice = grant({ subject: { kind: "member", id: "alice" } });
    const bob = grant({ subject: { kind: "member", id: "bob" } });

    expect(sortGrants([bob, alice, ops, everyone], directory)).toEqual([everyone, ops, alice, bob]);
  });

  it("tell a grant of every model from a narrower one", () => {
    expect(givesEveryModel(grant({ models: ["claude-*", "*"] }))).toBe(true);
    expect(givesEveryModel(grant({ models: ["claude-*"] }))).toBe(false);
  });
});

describe("reading grants", () => {
  const everyone = grant({});

  const researchSonnet = grant({
    subject: { kind: "team", id: "research" },
    scope: { kind: "provider", provider: "claude" },
    models: ["claude-sonnet-*"],
  });

  const aliceWork = grant({
    subject: { kind: "member", id: "alice" },
    scope: { kind: "credential", id: "work.json" },
  });

  const all = [aliceWork, researchSonnet, everyone];

  it("by member lists what reaches each member: their own, their teams' and everyone's", () => {
    const groups = groupGrants(all, "member", directory);

    expect(groups.map((group) => group.label)).toEqual(["alice@example.com", "bob@example.com"]);
    expect(groups[0]?.grants).toEqual([everyone, aliceWork]);
    expect(groups[1]?.grants).toEqual([everyone, researchSonnet]);
  });

  it("by team lists everyone and each team, a team without grants with an empty list", () => {
    const groups = groupGrants(all, "team", directory);

    expect(groups.map((group) => [group.label, group.grants.length])).toEqual([
      ["Everyone", 1],
      ["OPS", 0],
      ["RESEARCH", 1],
    ]);
  });

  it("by credential lists who may use each account, provider or all of them", () => {
    const groups = groupGrants(all, "credential", directory);

    expect(groups.map((group) => group.label)).toEqual([
      "All shared credentials",
      "work.json",
      "Every claude account",
    ]);
    expect(groups[0]?.grants).toEqual([everyone]);
  });
});

describe("my models", () => {
  const models = [
    {
      id: "claude-sonnet-4-5",
      display_name: "Claude Sonnet 4.5",
      owned_by: "anthropic",
      type: "claude",
    },
    { id: "gpt-5", owned_by: "openai", type: "openai" },
  ];

  it("filters by id or display name, case-insensitively, and keeps all for a blank query", () => {
    expect(filterMyModels(models, "  ")).toEqual(models);
    expect(filterMyModels(models, "SONNET").map((model) => model.id)).toEqual([
      "claude-sonnet-4-5",
    ]);
    expect(filterMyModels(models, "4.5").map((model) => model.id)).toEqual(["claude-sonnet-4-5"]);
    expect(filterMyModels(models, "nothing")).toEqual([]);
  });

  it("tells a member with no models what to ask for", () => {
    expect(modelsNote(0)).toMatch(/Grants page/);
    expect(modelsNote(2)).toBe("");
  });
});
