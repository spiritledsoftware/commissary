// Price overrides (ADR 0024): entries of an org's ControlPlane with revisions, kept across a config import, and
// created for a ControlPlane that predates their table.
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { OrgId } from "@commissary/core";
import { controlPlane, resetControlPlane } from "./support/control-plane.ts";
import { ConfigStore, type PriceOverrideValue } from "../src/config/store.ts";
import { orgDataKey } from "./support/secrets.ts";

beforeEach(resetControlPlane);

const GPT = { provider: "codex", model: "gpt-5", input: 1.25, output: 10 };

/** Creates the override in `options` (GPT by default) and answers its id and revision. */
const created = async (options: { readonly value?: PriceOverrideValue } = {}) => {
  const result = await controlPlane()
    .models()
    .writePriceOverride({ revision: 0, value: options.value ?? GPT }, "a");

  if (!result.ok) throw new Error(`expected a created override: ${result.message}`);

  return result;
};

describe("price override entries", () => {
  it("creates an override with an id, a revision and the writer, and lists it", async () => {
    const result = await controlPlane()
      .models()
      .writePriceOverride(
        { revision: 0, value: { ...GPT, cache_read: 0.125 } },
        "admin@example.com",
      );

    expect(result).toMatchObject({ ok: true, id: expect.stringMatching(/^price:[0-9a-f]{24}$/) });
    const { version, overrides } = await controlPlane().models().priceOverrideEntries();

    expect(overrides).toEqual([
      {
        ...GPT,
        cache_read: 0.125,
        id: result.ok ? result.id : "",
        revision: result.ok ? result.revision : -1,
        updated_at: expect.any(Number),
        updated_by: "admin@example.com",
      },
    ]);
    // The write moved the version readers rebuild on, and the snapshot carries the overrides.
    expect(result.ok && result.version).toBe(version);

    const snapshot = await controlPlane().models().getConfig();

    expect(snapshot.priceOverrides).toEqual(overrides);
    expect(
      (await controlPlane().models().getConfig(snapshot.version)).priceOverrides,
    ).toBeUndefined();
  });

  it("stores the provider lower-cased and finds a duplicate however the pair is cased", async () => {
    await created({ value: { ...GPT, provider: " Codex ", model: " GPT-5 " } });
    const [only] = (await controlPlane().models().priceOverrideEntries()).overrides;

    expect(only).toMatchObject({ provider: "codex", model: "GPT-5" });

    const again = await controlPlane()
      .models()
      .writePriceOverride({ revision: 0, value: { ...GPT, model: "gpt-5" } }, "b");

    expect(again).toMatchObject({ ok: false, error: "conflict" });
    expect((await controlPlane().models().priceOverrideEntries()).overrides).toHaveLength(1);
  });

  it("replaces an override at its revision and refuses a stale one", async () => {
    const first = await created();

    const replaced = await controlPlane()
      .models()
      .writePriceOverride(
        { id: first.id, revision: first.revision, value: { ...GPT, input: 2, output: 12 } },
        "b",
      );

    expect(replaced).toMatchObject({ ok: true, id: first.id });
    expect(replaced.ok && replaced.revision).toBeGreaterThan(first.revision);

    const stale = await controlPlane()
      .models()
      .writePriceOverride(
        { id: first.id, revision: first.revision, value: { ...GPT, input: 3 } },
        "c",
      );

    expect(stale).toMatchObject({ ok: false, error: "conflict" });
    expect((await controlPlane().models().priceOverrideEntries()).overrides).toMatchObject([
      { id: first.id, input: 2, output: 12, updated_by: "b" },
    ]);
  });

  it("refuses to move an override onto the provider and model of another", async () => {
    const first = await created();
    const second = await created({ value: { ...GPT, model: "gpt-5-mini" } });

    const moved = await controlPlane()
      .models()
      .writePriceOverride({ id: second.id, revision: second.revision, value: GPT }, "a");

    expect(moved).toMatchObject({ ok: false, error: "conflict" });
    expect(
      (await controlPlane().models().priceOverrideEntries()).overrides.map((entry) => entry.id),
    ).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it("deletes an override at its revision, and an unknown or deleted one is not found or a conflict", async () => {
    const first = await created();

    expect(
      await controlPlane()
        .models()
        .writePriceOverride({ id: first.id, revision: first.revision + 1, value: null }, "a"),
    ).toMatchObject({ ok: false, error: "conflict" });

    expect(
      await controlPlane()
        .models()
        .writePriceOverride({ id: first.id, revision: first.revision, value: null }, "a"),
    ).toMatchObject({ ok: true, id: first.id, revision: 0 });
    expect((await controlPlane().models().priceOverrideEntries()).overrides).toEqual([]);

    // A client that read the override before it was deleted conflicts; one that never saw it finds nothing.
    expect(
      await controlPlane()
        .models()
        .writePriceOverride({ id: first.id, revision: first.revision, value: GPT }, "a"),
    ).toMatchObject({ ok: false, error: "conflict" });

    expect(
      await controlPlane()
        .models()
        .writePriceOverride({ id: "price:none", revision: 0, value: null }, "a"),
    ).toMatchObject({ ok: false, error: "not_found" });
  });

  it("never reuses a revision for an override created again", async () => {
    const first = await created();
    await controlPlane()
      .models()
      .writePriceOverride({ id: first.id, revision: first.revision, value: null }, "a");

    const again = await created();

    expect(again.revision).toBeGreaterThan(first.revision);
  });

  it("refuses a missing name or a price that is not a number from 0 to the cap", async () => {
    const { version } = await controlPlane().models().getConfig();

    const bad: ReadonlyArray<object> = [
      { provider: " " },
      { model: "" },
      { input: -1 },
      { output: Number.NaN },
      { input: Number.POSITIVE_INFINITY },
      { cache_read: -0.5 },
      { cache_write: 100_001 },
    ];

    for (const change of bad) {
      const result = await controlPlane()
        .models()
        .writePriceOverride({ revision: 0, value: { ...GPT, ...change } }, "a");

      expect(result, JSON.stringify(change)).toMatchObject({ ok: false, error: "invalid" });
    }

    expect((await controlPlane().models().priceOverrideEntries()).overrides).toEqual([]);
    expect((await controlPlane().models().getConfig()).version).toBe(version);
  });

  it("survives an import of a config document, which replaces the config entries", async () => {
    const first = await created();

    const imported = await controlPlane()
      .models()
      .importConfig("routing:\n  strategy: fill-first\n", "a");

    expect(imported.ok).toBe(true);
    expect((await controlPlane().models().priceOverrideEntries()).overrides).toMatchObject([
      { id: first.id, revision: first.revision },
    ]);
  });

  it("keeps the overrides of each org to that org", async () => {
    const other = OrgId.make(`prices-${crypto.randomUUID().slice(0, 8)}`);
    await created();

    expect((await controlPlane(other).models().priceOverrideEntries()).overrides).toEqual([]);
  });

  it("is added to a ControlPlane that predates the table and keeps what it holds", async () => {
    const org = OrgId.make(`before-${crypto.randomUUID().slice(0, 8)}`);
    const stub = controlPlane(org);

    const before = await stub
      .models()
      .writeSettings([{ id: "routing.strategy", revision: 0, value: "fill-first" }], "a");

    expect(before.ok).toBe(true);
    const made = await stub.models().writePriceOverride({ revision: 0, value: GPT }, "a");

    expect(made.ok).toBe(true);

    await runInDurableObject(stub, async (_instance, state) => {
      // The state before the change: no table for overrides (nor its index).
      state.storage.sql.exec("DROP TABLE config_price_overrides");

      // The next start creates it, empty, next to the entries that were there; running the schema again is harmless.
      const secrets = await orgDataKey(state, org);
      const transaction = <T>(body: () => T): T => state.storage.transactionSync(body);
      const store = new ConfigStore(state.storage.sql, org, transaction, secrets);

      new ConfigStore(state.storage.sql, org, transaction, secrets);

      expect(store.priceOverrides()).toEqual([]);
      expect(store.current().config.routing.strategy).toBe("fill-first");

      const written = store.writePriceOverride({ revision: 0, value: GPT }, "a");

      expect(written.ok).toBe(true);
      expect(store.priceOverrides()).toHaveLength(1);
    });
  });
});
