// The model catalog's status and on-demand refresh (`GET /models/catalog`, `POST /models/catalog/refresh`) through the
// router with the real ControlPlane (settings), the Platform registry (refresh lease) and KV, and mocked outbound HTTP.
import { env } from "cloudflare:workers";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CatalogRefresh, CatalogStatus } from "@commissary/contract/catalog";
import { platformOf } from "@commissary/state";
import {
  controlPlane,
  jsonInit,
  makeHarness,
  resetControlPlane,
  token,
} from "./support/management.ts";
import { CATALOG_KEYS, documentText, mdModel, MODELS_DEV_URL } from "@commissary/models/testing";

const STATUS = "/v9/management/models/catalog";

const REFRESH = "/v9/management/models/catalog/refresh";

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

let reply: () => Reply | Promise<Reply> = () => ({ status: 200, body: documentText() });

const harness = makeHarness(() => reply());

afterAll(harness.dispose);

const post = () => harness.json(REFRESH, jsonInit("POST", {}));

const status = async () => (await harness.json(STATUS)).body as CatalogStatus;

beforeEach(async () => {
  harness.requests.length = 0;
  reply = () => ({ status: 200, body: documentText() });
  await resetControlPlane();
  await env.CACHE.delete(CATALOG_KEYS.modelsDev);
  await env.CACHE.delete(CATALOG_KEYS.status);
});

describe("GET /models/catalog", () => {
  it("reports the shipped copy before any refresh", async () => {
    const view = await harness.json(STATUS);
    const body = view.body as CatalogStatus;

    expect(view.status).toBe(200);
    expect(body).toMatchObject({ mode: "official", stored: false });
    expect(body.refreshed_at).toBeUndefined();
    expect(body.last_attempt).toBeUndefined();
    expect(Object.keys(body.models)).toContain("anthropic");
    expect(Object.values(body.models).every((count) => count > 0)).toBe(true);
  });

  it("names the source mode and the host of a custom source", async () => {
    await controlPlane()
      .models()
      .importConfig("models:\n  catalog: https://catalog.example.test/api.json\n", "test");
    expect(await status()).toMatchObject({ mode: "custom", source_host: "catalog.example.test" });

    await controlPlane().models().importConfig("models:\n  catalog: embed\n", "test");
    expect(await status()).toMatchObject({ mode: "embed" });

    await controlPlane().models().importConfig("models:\n  catalog: disabled\n", "test");
    expect(await status()).toMatchObject({ mode: "disabled" });
  });

  it("embed reports the shipped copy even while a stored copy is still in KV", async () => {
    await post();
    expect(await status()).toMatchObject({ mode: "official", stored: true });

    await controlPlane().models().importConfig("models:\n  catalog: embed\n", "test");
    const embedded = await status();

    expect(embedded).toMatchObject({ mode: "embed", stored: false });
    expect(embedded.refreshed_at).toBeUndefined();
    expect(embedded.models["opencode"]).toBeGreaterThan(4);
  });

  it("says why an address that is not http(s) is not used", async () => {
    await controlPlane()
      .models()
      .importConfig("models:\n  catalog: ftp://catalog.example.test/api.json\n", "test");
    const body = await status();

    expect(body).toMatchObject({
      mode: "disabled",
      source_problem: "models.catalog must be an http(s) URL",
    });

    const refused = await post();

    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain("must be an http(s) URL");
  });

  it("is behind the admin gate", async () => {
    expect((await harness.call(STATUS, { auth: false })).status).toBe(401);
    expect((await harness.call(STATUS, { auth: await token("other@example.com") })).status).toBe(
      403,
    );
  });
});

describe("POST /models/catalog/refresh", () => {
  it("downloads, stores and reports what changed; the next refresh finds it unchanged", async () => {
    const first = await post();
    const body = first.body as CatalogRefresh;

    expect(first.status).toBe(200);
    expect(body.status).toBe("updated");
    expect(body.added).toBeGreaterThan(0);
    expect(body.removed).toBeGreaterThanOrEqual(0);
    expect(body.catalog).toMatchObject({ mode: "official", stored: true, models: { opencode: 4 } });
    expect(body.catalog.refreshed_at).toBeDefined();
    expect(body.catalog.last_attempt).toMatchObject({ status: "updated" });
    expect(harness.requests.map((request) => request.url)).toEqual([MODELS_DEV_URL]);
    expect(await env.CACHE.get(CATALOG_KEYS.modelsDev)).toContain("claude-test");

    const again = (await post()).body as CatalogRefresh;
    expect(again.status).toBe("unchanged");
    expect(again.added).toBeUndefined();
    expect(again.catalog.stored).toBe(true);

    expect(await status()).toMatchObject({ stored: true, last_attempt: { status: "unchanged" } });
  });

  it("counts the models that appeared and disappeared against the stored catalog", async () => {
    await post();
    reply = () => ({
      status: 200,
      body: documentText({
        anthropic: { "claude-new": mdModel("claude-new") },
        xai: { "grok-new": mdModel("grok-new"), "grok-more": mdModel("grok-more") },
      }),
    });

    const body = (await post()).body as CatalogRefresh;
    expect(body).toMatchObject({ status: "updated", added: 3, removed: 0 });
  });

  it("a failed download keeps the stored catalog and says why", async () => {
    await post();
    const stored = await env.CACHE.get(CATALOG_KEYS.modelsDev);
    const refreshedAt = (await status()).refreshed_at;
    reply = () => ({ status: 503, body: "down" });

    const failed = await post();
    const body = failed.body as CatalogRefresh;

    expect(failed.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.message).toBe("catalog source answered HTTP 503");
    expect(body.catalog).toMatchObject({
      stored: true,
      last_attempt: { status: "failed", message: "catalog source answered HTTP 503" },
    });
    // The time of the last successful refresh is kept.
    expect(body.catalog.refreshed_at).toBe(refreshedAt);
    expect(await env.CACHE.get(CATALOG_KEYS.modelsDev)).toBe(stored);
  });

  it("an invalid document keeps the stored catalog", async () => {
    await post();
    const stored = await env.CACHE.get(CATALOG_KEYS.modelsDev);
    reply = () => ({ status: 200, body: { anthropic: { models: {} } } });

    const body = (await post()).body as CatalogRefresh;

    expect(body.status).toBe("failed");
    expect(body.message).toContain("invalid catalog");
    expect(await env.CACHE.get(CATALOG_KEYS.modelsDev)).toBe(stored);
  });

  it("a failure before anything was stored leaves the shipped copy in use", async () => {
    reply = () => ({ status: 500, body: "" });

    const body = (await post()).body as CatalogRefresh;

    expect(body.status).toBe("failed");
    expect(body.catalog.stored).toBe(false);
    expect(body.catalog.refreshed_at).toBeUndefined();
    expect(await env.CACHE.get(CATALOG_KEYS.modelsDev)).toBeNull();
  });

  it("uses the custom source of models.catalog", async () => {
    const custom = "https://catalog.example.test/api.json";
    await controlPlane().models().importConfig(`models:\n  catalog: ${custom}\n`, "test");

    const body = (await post()).body as CatalogRefresh;

    expect(body.status).toBe("updated");
    expect(body.catalog).toMatchObject({ mode: "custom", source_host: "catalog.example.test" });
    expect(harness.requests.map((request) => request.url)).toEqual([custom]);
  });

  it.each([
    ["embed", "Embedded copy"],
    ["disabled", "Off"],
  ])("is refused while models.catalog is %s", async (value, name) => {
    await controlPlane().models().importConfig(`models:\n  catalog: ${value}\n`, "test");

    const refused = await post();

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "catalog_not_fetched" });
    expect((refused.body as { message: string }).message).toContain(name);
    expect(harness.requests).toHaveLength(0);
    expect(await env.CACHE.get(CATALOG_KEYS.modelsDev)).toBeNull();
  });

  it("is behind the admin gate and the CSRF rules", async () => {
    expect((await harness.call(REFRESH, { method: "POST", auth: false })).status).toBe(401);
    expect(
      (
        await harness.call(REFRESH, {
          ...jsonInit("POST", {}),
          auth: await token("other@example.com"),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.call(REFRESH, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "a=b",
        })
      ).status,
    ).toBe(415);
    expect(harness.requests).toHaveLength(0);
  });
});

describe("concurrent refreshes", () => {
  it("a second refresh while one downloads is refused with 409 and asks nothing", async () => {
    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => (release = resolve));

    let entered: () => void = () => {};

    const started = new Promise<void>((resolve) => (entered = resolve));

    reply = async () => {
      entered();
      await gate;

      return { status: 200, body: documentText() };
    };

    const first = post();
    await started;

    const second = await post();
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: "catalog_refresh_running" });
    expect((second.body as { message: string }).message).toContain("the panel");
    // Only the first refresh made a request.
    expect(harness.requests).toHaveLength(1);

    release();
    const done = await first;
    expect(done.status).toBe(200);
    expect((done.body as CatalogRefresh).status).toBe("updated");

    // The lease is given back: the next refresh runs.
    expect((await post()).status).toBe(200);
  });

  it("a refresh holding the lease (the scheduled one) refuses the panel's", async () => {
    const taken = await platformOf(env).takeLease("catalog_refresh", "cron");

    if (!taken.ok) throw new Error("lease was held");

    const refused = await post();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "catalog_refresh_running" });
    expect((refused.body as { message: string }).message).toContain("scheduled refresh");
    expect(harness.requests).toHaveLength(0);

    await platformOf(env).releaseLease(taken.lease.token);
    expect((await post()).status).toBe(200);
  });

  it("a failed refresh gives the lease back too", async () => {
    reply = () => ({ status: 500, body: "" });
    expect(((await post()).body as CatalogRefresh).status).toBe("failed");

    reply = () => ({ status: 200, body: documentText() });
    expect(((await post()).body as CatalogRefresh).status).toBe("updated");
  });
});
