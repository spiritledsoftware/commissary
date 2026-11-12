// A private credential's models are listed to its owner alone (ADR 0023): `visibleTo` is the registry as one caller may
// list it, while the snapshot itself still resolves the model for routing; `shared` is the shared credentials alone.
import { describe, expect, it } from "vite-plus/test";
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
