// The registry as one member may list it under their grants (ADR 0023): a model is listed to a member only when one of
// its upstream models is granted to them on some shared credential that serves it. The snapshot itself still knows
// every model for routing; `visibleTo` is the per-member view, cached per snapshot (so per org, grants version and
// member).
import { describe, expect, it } from "vite-plus/test";
import type { GrantEntry, GrantTable } from "../src/grants/grant.ts";
import { routingView } from "../src/registry/routing-view.ts";
import { buildSnapshot } from "../src/registry/service.ts";
import type { ModelSource } from "../src/registry/source.ts";
import { authIndexOf } from "./support/auth-index.ts";
import { catalogs } from "./support/registry.ts";
import { configOf, ids, source } from "./support/registry-sources.ts";
import {
  allCredentials,
  credential,
  everyone,
  grant,
  member,
  provider,
  team,
} from "./support/grants.ts";

const NOW = 1_800_000_000_000;

const table = (
  grants: ReadonlyArray<GrantEntry>,
  teams: GrantTable["teams"] = [],
  version = 1,
): GrantTable => ({ version, grants, teams });

const snapshot = (sources: ModelSource[], grants: GrantTable | undefined, yaml = "") =>
  buildSnapshot({
    sources,
    config: configOf(yaml),
    catalogs,
    now: NOW,
    ...(grants === undefined ? {} : { grants }),
  });

const listed = (registry: ReturnType<typeof snapshot>, memberId: string | undefined) =>
  ids(registry.visibleTo(memberId).availableModels());

const claudeA = () => source("sub-a.json", "claude");

const codexB = () => source("sub-b.json", "codex");

describe("RegistrySnapshot.visibleTo under grants", () => {
  const registry = snapshot(
    [claudeA(), codexB()],
    table([
      grant(member("alice"), credential("sub-a.json"), ["claude-sonnet-*"]),
      grant(member("bob"), credential("sub-b.json"), ["*"]),
    ]),
  );

  const claude = ids(registry.index.modelsForClient("sub-a.json"));
  const codex = ids(registry.index.modelsForClient("sub-b.json"));
  const sonnets = claude.filter((id) => id.startsWith("claude-sonnet-"));
  const others = claude.filter((id) => !id.startsWith("claude-sonnet-"));

  it("has models to tell the members apart", () => {
    expect(sonnets.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    expect(codex.length).toBeGreaterThan(0);
  });

  it("lists different models to two members with different grants", () => {
    const alice = listed(registry, "alice");
    const bob = listed(registry, "bob");

    expect(alice).toEqual(expect.arrayContaining(sonnets));
    expect(bob).toEqual(expect.arrayContaining(codex));

    for (const id of [...others, ...codex]) expect(alice).not.toContain(id);

    for (const id of claude) expect(bob).not.toContain(id);
  });

  it("lists nothing to a member with no grant, and nothing to a request without a member", () => {
    expect(listed(registry, "carol")).toEqual([]);
    expect(listed(registry, undefined)).toEqual([]);
  });

  it("answers an ungranted model like an unknown one: no provider serves it", () => {
    const [opus] = others;

    expect(opus).toBeDefined();
    expect(registry.providersForModel(opus ?? "")).toEqual(["claude"]);
    expect(registry.visibleTo("alice").providersForModel(opus ?? "")).toEqual([]);
    expect(registry.visibleTo("alice").providersForModel(sonnets[0] ?? "")).toEqual(["claude"]);
  });

  it("keeps one view per member, built once", () => {
    expect(registry.visibleTo("alice")).toBe(registry.visibleTo("alice"));
    expect(registry.visibleTo("alice")).not.toBe(registry.visibleTo("bob"));
  });

  it("picks the first available model among the ones the member may use", () => {
    expect(registry.visibleTo("bob").firstAvailableModel()).toBeDefined();
    expect(registry.visibleTo("carol").firstAvailableModel()).toBeUndefined();
  });
});

describe("what makes a view the snapshot itself", () => {
  it("is every member's view when the default grant (everyone, all credentials, *) stands", () => {
    const registry = snapshot(
      [claudeA(), codexB()],
      table([grant(everyone, allCredentials, ["*"])]),
    );

    expect(registry.visibleTo("alice")).toBe(registry);
    expect(registry.visibleTo(undefined)).toBe(registry);
  });

  it("is every member's view when no grant table is given (a registry built without grants)", () => {
    const registry = snapshot([claudeA()], undefined);

    expect(registry.visibleTo("alice")).toBe(registry);
  });

  it("is not the snapshot once the default grant was replaced by narrower ones", () => {
    const registry = snapshot(
      [claudeA()],
      table([grant(everyone, allCredentials, ["claude-sonnet-*"])]),
    );

    const view = registry.visibleTo("alice");

    expect(view).not.toBe(registry);
    expect(ids(view.availableModels()).every((id) => id.startsWith("claude-sonnet-"))).toBe(true);
  });
});

describe("scopes, teams and everyone", () => {
  it("applies a team grant to the members of the team only", () => {
    const registry = snapshot(
      [claudeA()],
      table(
        [grant(team("t-1"), credential("sub-a.json"), ["*"])],
        [{ id: "t-1", members: ["carol"] }],
      ),
    );

    expect(listed(registry, "carol").length).toBeGreaterThan(0);
    expect(listed(registry, "dave")).toEqual([]);
    expect(listed(registry, undefined)).toEqual([]);
  });

  it("gives a request without a member only the grants for everyone", () => {
    const registry = snapshot(
      [claudeA()],
      table([
        grant(member("alice"), allCredentials, ["*"]),
        grant(everyone, provider("claude"), ["claude-sonnet-*"]),
      ]),
    );

    const none = listed(registry, undefined);

    expect(none.length).toBeGreaterThan(0);
    expect(none.every((id) => id.startsWith("claude-sonnet-"))).toBe(true);
    expect(listed(registry, "alice").length).toBeGreaterThan(none.length);
  });

  it("does not let a grant for one provider list another provider's models", () => {
    const registry = snapshot(
      [claudeA(), codexB()],
      table([grant(member("alice"), provider("claude"), ["*"])]),
    );

    const codex = ids(registry.index.modelsForClient("sub-b.json"));

    for (const id of codex) expect(listed(registry, "alice")).not.toContain(id);
  });
});

describe("aliases and prefixes", () => {
  const aliased = (aliases: ModelSource["modelAliases"], extra: Partial<ModelSource> = {}) =>
    source("sub-a.json", "claude", { modelAliases: aliases, ...extra });

  const sonnetOnly = table([grant(member("alice"), allCredentials, ["claude-sonnet-*"])]);

  const sonnet = () => {
    const [first] = ids(
      snapshot([claudeA()], undefined).index.modelsForClient("sub-a.json"),
    ).filter((id) => id.startsWith("claude-sonnet-"));

    return first ?? "";
  };

  const opus = () => {
    const [first] = ids(
      snapshot([claudeA()], undefined).index.modelsForClient("sub-a.json"),
    ).filter((id) => id.startsWith("claude-opus-"));

    return first ?? "";
  };

  it("lists an alias only when its upstream model is granted", () => {
    const registry = snapshot(
      [
        aliased([
          { name: sonnet(), alias: "fast" },
          { name: opus(), alias: "smart" },
        ]),
      ],
      sonnetOnly,
    );

    const alice = listed(registry, "alice");

    expect(alice).toContain("fast");
    expect(alice).not.toContain("smart");
    expect(alice).not.toContain(opus());
  });

  it("lists `prefix/model` only when the model is granted on the credential behind the prefix", () => {
    const registry = snapshot([aliased([], { prefix: "work" })], sonnetOnly);
    const alice = listed(registry, "alice");

    expect(alice).toContain(`work/${sonnet()}`);
    expect(alice).not.toContain(`work/${opus()}`);
  });

  it("lists a pool alias when any member of the pool is granted", () => {
    const keyed = source("key-a", "claude", {
      source: "config",
      authKind: "apikey",
      models: [
        { name: opus(), alias: "any" },
        { name: sonnet(), alias: "any" },
      ],
    });

    const registry = snapshot([keyed], sonnetOnly);

    expect(listed(registry, "alice")).toContain("any");
    expect(
      listed(
        snapshot([keyed], table([grant(member("alice"), allCredentials, ["gpt-*"])])),
        "alice",
      ),
    ).not.toContain("any");
  });
});

describe("private credentials", () => {
  it("are listed to their owner whatever the grants say", () => {
    const owned: ModelSource = { ...source("mine.json", "codex"), owner: "alice" };

    const registry = snapshot(
      [owned, claudeA()],
      table([grant(member("bob"), allCredentials, ["*"])]),
    );

    const codex = ids(registry.index.modelsForClient("mine.json"));

    expect(listed(registry, "alice")).toEqual(expect.arrayContaining(codex));
    expect(listed(registry, "bob")).not.toContain(codex[0]);
  });
});

describe("the routing view", () => {
  const view = (registry: ReturnType<typeof snapshot>, memberId: string | undefined) =>
    routingView(registry.visibleTo(memberId), NOW, authIndexOf).models.map((model) => model.id);

  it("shows a member only the models they may use", () => {
    const registry = snapshot(
      [claudeA(), codexB()],
      table([grant(member("alice"), credential("sub-a.json"), ["claude-sonnet-*"])]),
    );

    const alice = view(registry, "alice");

    expect(alice.length).toBeGreaterThan(0);
    expect(alice.every((id) => id.startsWith("claude-sonnet-"))).toBe(true);
    expect(view(registry, "bob")).toEqual([]);
  });
});
