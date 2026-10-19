// Org-scoped KV and caches (ADR 0044): org data is reachable only through the org's own names.
import { describe, expect, it } from "vitest";
import {
  deploymentKey,
  deploymentKv,
  GLOBAL_ORG,
  type KvBinding,
  makeOrgCache,
  OrgId,
  orgKv,
} from "../src/index.ts";

/** An in-memory namespace that records the raw names it was given. */
const fakeKv = () => {
  const data = new Map<string, string>();

  const binding: KvBinding = {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
    list: async ({ prefix = "", limit = 1000 }) => {
      const names = [...data.keys()].filter((name) => name.startsWith(prefix));

      return {
        keys: names.slice(0, limit).map((name) => ({ name })),
        list_complete: names.length <= limit,
      };
    },
  };

  return { data, binding };
};

const acme = OrgId.make("acme");

const beta = OrgId.make("beta");

describe("orgKv", () => {
  it("scopes every name to its org and keeps global's names unprefixed", async () => {
    const { data, binding } = fakeKv();

    await orgKv(binding, acme).put("k", "acme", { expirationTtl: 60 });
    await orgKv(binding, GLOBAL_ORG).put("k", "global");

    expect([...data.entries()]).toEqual([
      ["org.acme.k", "acme"],
      ["k", "global"],
    ]);
    expect(await orgKv(binding, beta).get("k")).toBeNull();

    await orgKv(binding, beta).delete("k");
    expect(data.size).toBe(2);
  });

  it("deletes only the org's own entries, a page at a time, and never lists global's", async () => {
    const { data, binding } = fakeKv();

    data.set("registry/models-dev.json", "catalog");
    data.set("k", "global");

    for (let i = 0; i < 5; i += 1) await orgKv(binding, acme).put(`k${i}`, "v");
    await orgKv(binding, beta).put("k0", "v");

    const first = await orgKv(binding, acme).deletePage(3);
    expect(first).toEqual({ deleted: 3, complete: false });
    expect(await orgKv(binding, acme).deletePage(3)).toEqual({ deleted: 2, complete: true });
    expect(await orgKv(binding, GLOBAL_ORG).deletePage(3)).toEqual({ deleted: 0, complete: true });
    expect([...data.keys()].toSorted()).toEqual(["k", "org.beta.k0", "registry/models-dev.json"]);
  });
});

describe("orgKv names of global", () => {
  it("refuses a name that starts with org., which would reach another org's entry", async () => {
    const { data, binding } = fakeKv();

    await orgKv(binding, acme).put("x", "acme's");

    const global = orgKv(binding, GLOBAL_ORG);

    await expect(global.get("org.acme.x")).rejects.toThrow("org.");
    await expect(global.put("org.acme.x", "global's")).rejects.toThrow("org.");
    await expect(global.delete("org.acme.x")).rejects.toThrow("org.");
    expect(data.get("org.acme.x")).toBe("acme's");
  });
});

describe("deploymentKv", () => {
  it("reads and writes the names it is given as they are", async () => {
    const { data, binding } = fakeKv();
    const key = deploymentKey("xai/client-version");

    await deploymentKv(binding).put(key, "1.2.3");
    expect(data.get("xai/client-version")).toBe("1.2.3");
    expect(await deploymentKv(binding).get(key)).toBe("1.2.3");
    await deploymentKv(binding).delete(key);
    expect(data.size).toBe(0);
  });
});

describe("makeOrgCache", () => {
  it("keeps one value per org and name", () => {
    const cache = makeOrgCache<number>();

    cache.set(acme, "x", 1);
    cache.set(GLOBAL_ORG, "x", 2);

    expect(cache.get(acme, "x")).toBe(1);
    expect(cache.get(GLOBAL_ORG, "x")).toBe(2);
    expect(cache.get(beta, "x")).toBeUndefined();

    cache.delete(acme, "x");
    expect(cache.get(acme, "x")).toBeUndefined();
    expect(cache.get(GLOBAL_ORG, "x")).toBe(2);

    cache.clear();
    expect(cache.get(GLOBAL_ORG, "x")).toBeUndefined();
  });

  it("does not take global's name that looks like another org's scoped name for that org's entry", () => {
    const cache = makeOrgCache<string>();

    cache.set(GLOBAL_ORG, "org.acme.x", "global's");

    expect(cache.get(acme, "x")).toBeUndefined();
    expect(cache.get(GLOBAL_ORG, "org.acme.x")).toBe("global's");

    cache.set(acme, "x", "acme's");
    expect(cache.get(GLOBAL_ORG, "org.acme.x")).toBe("global's");
    expect(cache.size).toBe(2);
  });

  it("drops the entries a predicate picks and the oldest one when it is full", () => {
    const cache = makeOrgCache<number>(2);

    cache.set(acme, "a", 1);
    cache.set(beta, "a", 2);
    cache.set(beta, "b", 3);
    expect(cache.get(acme, "a")).toBeUndefined();
    expect(cache.size).toBe(2);

    cache.deleteWhere((org) => org === beta);
    expect(cache.size).toBe(0);
  });
});
