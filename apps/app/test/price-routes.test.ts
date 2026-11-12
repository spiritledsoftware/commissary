// The price override routes (`/v9/management/price-overrides`, ADR 0024) through the Access gate and the real
// ControlPlane: create, list, replace and delete with `If-Match` revisions, and the answers for stale or invalid edits.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { afterAll, beforeEach, expect } from "vite-plus/test";
import type { Json } from "@commissary/json";
import { ManagementApi } from "@commissary/contract/api";
import { ManagementError } from "@commissary/contract/errors";
import { OrgId } from "@commissary/core";
import {
  controlPlane,
  type Harness,
  jsonInit,
  makeHarness,
  resetControlPlane,
} from "./support/management.ts";

const harness = makeHarness();

afterAll(harness.dispose);

beforeEach(resetControlPlane);

const BASE = "/v9/management/price-overrides";

const GPT = { provider: "codex", model: "gpt-5", input: 1.25, output: 10, cache_read: 0.125 };

/** A request with the revision it is based on in `If-Match` (none when `revision` is `undefined`). */
const edit = (method: string, revision: string | undefined, body?: Json): RequestInit => ({
  method,
  headers: {
    "content-type": "application/json",
    ...(revision === undefined ? {} : { "if-match": revision }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const create = async (body: Json = GPT) => {
  const response = await harness.json(BASE, jsonInit("POST", body));

  expect(response.status).toBe(200);

  // SAFETY: the shape is checked against the contract below.
  // SAFETY: a saved override answers with these three fields (checked by the status assertions around it).
  return response.body as { id: string; revision: number; version: number };
};

describe("price override routes", () => {
  it("creates an override and lists it with its revision and writer", async () => {
    const saved = await create();

    expect(saved).toMatchObject({ status: "ok", id: expect.stringMatching(/^price:/) });

    const list = await harness.json(BASE);

    expect(list.status).toBe(200);

    expect(list.body).toEqual({
      version: saved.version,
      overrides: [
        {
          ...GPT,
          id: saved.id,
          revision: saved.revision,
          updated_at: expect.any(Number),
          updated_by: "user:admin@example.com",
        },
      ],
    });
  });

  it("refuses a second override for the same provider and model with 409", async () => {
    await create();

    const again = await harness.json(
      BASE,
      jsonInit("POST", { ...GPT, provider: "CODEX", model: "GPT-5" }),
    );

    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "conflict" });
  });

  it("replaces an override at the revision in If-Match and refuses a stale one with 409", async () => {
    const saved = await create();

    const replaced = await harness.json(
      `${BASE}/${encodeURIComponent(saved.id)}`,
      edit("PUT", `"${saved.revision}"`, { ...GPT, input: 2 }),
    );

    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ status: "ok", id: saved.id });

    const stale = await harness.json(
      `${BASE}/${encodeURIComponent(saved.id)}`,
      edit("PUT", `"${saved.revision}"`, { ...GPT, input: 3 }),
    );

    expect(stale.status).toBe(409);
    const [stored] = (await controlPlane().models().priceOverrideEntries()).overrides;

    expect(stored).toMatchObject({ id: saved.id, input: 2 });
  });

  it("deletes an override at its revision; deleting an unknown id is 404", async () => {
    const saved = await create();
    const path = `${BASE}/${encodeURIComponent(saved.id)}`;

    const stale = await harness.json(path, edit("DELETE", String(saved.revision + 1)));

    expect(stale.status).toBe(409);

    const removed = await harness.json(path, edit("DELETE", `W/"${saved.revision}"`));

    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ status: "ok", id: saved.id, revision: 0 });
    // SAFETY: the list answers `{ version, overrides }`.
    expect(((await harness.json(BASE)).body as { overrides: unknown[] }).overrides).toEqual([]);

    const missing = await harness.json(`${BASE}/price:nothing`, edit("DELETE", "0"));

    expect(missing.status).toBe(404);
  });

  it("answers a missing or malformed If-Match with 400 invalid_if_match", async () => {
    const saved = await create();
    const path = `${BASE}/${encodeURIComponent(saved.id)}`;

    for (const header of [undefined, "abc", "-1", ""]) {
      const response = await harness.json(path, edit("PUT", header, GPT));

      expect(response.status, String(header)).toBe(400);
      expect(response.body).toMatchObject({ error: "invalid_if_match" });
    }
  });

  it("refuses a body of the wrong shape with 400 and an out-of-range value with 422", async () => {
    for (const body of [
      { ...GPT, input: "1" },
      { ...GPT, model: 5 },
      { provider: "codex", model: "gpt-5", input: 1 },
      { ...GPT, cache_write: null },
    ]) {
      const response = await harness.json(BASE, jsonInit("POST", body));

      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body).toMatchObject({ error: "invalid body" });
    }

    for (const body of [
      { ...GPT, input: -1 },
      { ...GPT, provider: "  " },
      { ...GPT, output: 1_000_000 },
    ]) {
      const response = await harness.json(BASE, jsonInit("POST", body));

      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(response.body).toMatchObject({ error: "invalid_config" });
    }

    expect((await controlPlane().models().priceOverrideEntries()).overrides).toEqual([]);
  });

  it("keeps each org's overrides to that org", async () => {
    const other = OrgId.make(`prices-${crypto.randomUUID().slice(0, 8)}`);
    const orgHarness = makeHarness(undefined, {}, other);

    try {
      await create();

      const theirs = await orgHarness.json(BASE);

      expect(theirs.body).toMatchObject({ overrides: [] });
    } finally {
      await orgHarness.dispose();
    }
  });

  it("needs an Access identity", async () => {
    const response = await harness.json(BASE, { auth: false });

    expect(response.status).toBe(401);
  });
});

/** The generated client of the management contract decodes the same routes. */
const client = HttpApiClient.make(ManagementApi, { baseUrl: "https://commissary.test" });

const fetchVia =
  (target: Harness): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    return await target.call(`${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      ...(request.body === null ? {} : { body: await request.text() }),
    });
  };

describe("price override contract", () => {
  it.effect("decodes the list, the saves and the errors through the generated client", () =>
    Effect.gen(function* () {
      const api = yield* client;
      const saved = yield* api.prices.create({ payload: GPT });

      assert.strictEqual(saved.status, "ok");

      const list = yield* api.prices.list();

      assert.deepStrictEqual(
        list.overrides.map((entry) => [entry.id, entry.provider, entry.model, entry.input]),
        [[saved.id, "codex", "gpt-5", 1.25]],
      );

      const replaced = yield* api.prices.replace({
        params: { id: saved.id },
        headers: { "if-match": String(saved.revision) },
        payload: { ...GPT, output: 11 },
      });

      assert.isAbove(replaced.revision, saved.revision);

      const conflict = yield* Effect.flip(
        api.prices.replace({
          params: { id: saved.id },
          headers: { "if-match": String(saved.revision) },
          payload: GPT,
        }),
      );

      assert.instanceOf(conflict, ManagementError);
      assert.strictEqual(conflict.error, "conflict");

      const removed = yield* api.prices.remove({
        params: { id: saved.id },
        headers: { "if-match": String(replaced.revision) },
      });

      assert.strictEqual(removed.revision, 0);
      assert.deepStrictEqual((yield* api.prices.list()).overrides, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          Layer.succeed(FetchHttpClient.Fetch, fetchVia(harness)),
        ),
      ),
    ),
  );
});
