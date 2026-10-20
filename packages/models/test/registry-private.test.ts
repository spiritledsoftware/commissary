// A private credential's models are listed to its owner alone (ADR 0023): `visibleTo` is the registry as one caller may
// list it, while the snapshot itself still resolves the model for routing; `shared` is the shared credentials alone.
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../src/registry/service.ts";
import type { ModelSource } from "../src/registry/source.ts";
import { catalogs } from "./support/registry.ts";
import { configOf, source } from "./support/registry-sources.ts";

const NOW = 1_800_000_000_000;

const owned = (name: string, owner: string): ModelSource => ({
  ...source(name, "codex"),
  owner,
});

const snapshot = (sources: ModelSource[]) =>
  buildSnapshot({ sources, config: configOf(""), catalogs, now: NOW });

describe("RegistrySnapshot.visibleTo", () => {
  it("lists a private credential's models to its owner and to nobody else", () => {
    const registry = snapshot([source("shared.json", "claude"), owned("alice.json", "mem-a")]);

    const ids = (memberId: string | undefined) =>
      registry
        .visibleTo(memberId)
        .availableModels()
        .map((model) => model.id);

    const codex = registry.index.modelsForClient("alice.json").map((model) => model.id);

    expect(codex.length).toBeGreaterThan(0);
    expect(ids("mem-a")).toEqual(expect.arrayContaining(codex));

    for (const other of ["mem-b", undefined]) {
      for (const id of codex) expect(ids(other)).not.toContain(id);
    }

    expect(ids("mem-b").length).toBeGreaterThan(0);
  });

  it("is the snapshot itself when no credential is private", () => {
    const registry = snapshot([source("shared.json", "claude")]);

    expect(registry.visibleTo("mem-a")).toBe(registry);
    expect(registry.visibleTo(undefined)).toBe(registry);
  });

  it("keeps the unfiltered snapshot resolving the model for routing", () => {
    const registry = snapshot([owned("alice.json", "mem-a")]);

    const [model] = registry.index.modelsForClient("alice.json");

    expect(model).toBeDefined();
    expect(registry.providersForModel(model!.id)).toEqual(["codex"]);
    expect(registry.visibleTo("mem-b").providersForModel(model!.id)).toEqual([]);
  });
});

// The registry of the shared credentials alone (#226): what an org admin may name as a shared agent's model.
describe("RegistrySnapshot.shared", () => {
  const sharedClaude = () =>
    source("shared.json", "claude", {
      modelAliases: [{ name: "claude-sonnet-4-6", alias: "team-sonnet" }],
    });

  it("serves the shared credentials' models, aliases applied, and no private credential's", () => {
    const registry = snapshot([sharedClaude(), owned("alice.json", "mem-a")]);
    const codex = registry.index.modelsForClient("alice.json").map((model) => model.id);
    const shared = registry.shared();

    expect(codex.length).toBeGreaterThan(0);
    expect(shared.providersForModel("team-sonnet")).toEqual(["claude"]);
    expect(shared.providersForModel("claude-sonnet-4-6")).toEqual([]);

    for (const id of codex) expect(shared.providersForModel(id)).toEqual([]);
    expect(registry.shared()).toBe(shared);
  });

  it("ignores the grants: a shared credential granted to nobody still counts", () => {
    const registry = buildSnapshot({
      sources: [sharedClaude(), owned("alice.json", "mem-a")],
      config: configOf(""),
      catalogs,
      now: NOW,
      grants: { version: 1, grants: [], teams: [] },
    });

    expect(registry.visibleTo("mem-b").providersForModel("team-sonnet")).toEqual([]);
    expect(registry.shared().providersForModel("team-sonnet")).toEqual(["claude"]);
  });

  it("is the snapshot itself when no credential is private", () => {
    const registry = snapshot([sharedClaude()]);

    expect(registry.shared()).toBe(registry);
  });
});
