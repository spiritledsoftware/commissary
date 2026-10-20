// The shared management contract (packages/contract) against the real handlers: the panel's generated client
// calls the management routes through the Access gate and must decode what they answer.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { ManagementApi, scopedApiUrl } from "@commissary/contract/api";
import type { ProviderKeysList, GroupView } from "@commissary/contract/provider-keys";
import { ManagementError } from "@commissary/contract/errors";
import { UsageGroupBy } from "@commissary/contract/usage";
import {
  claudeFile,
  controlPlane,
  type Harness,
  isolatedPlatform,
  makeHarness,
  resetControlPlane,
} from "./support/management.ts";
import {
  authIndexOf,
  CATALOG_KEYS,
  documentText,
  FULL_ACCESS,
  GROUP_BY,
  insertUsageRecord,
  type MockHandler,
  type RecordedRequest,
  resetUsageDb,
  sampleRecord,
} from "@commissary/models/testing";

const harness = makeHarness();

// The ControlPlane Durable Object reaches providers through `globalThis.fetch` (resolved once by FetchHttpClient): one
// stable stub delegates to the current test's upstream table. The generated client's own `fetch` is separate (`through`).
type Upstream = (request: { method: string; url: string }) => Response | undefined;

let upstream: Upstream = () => undefined;

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    return (
      upstream({ method: request.method, url: request.url }) ??
      new Response("no upstream route", { status: 599 })
    );
  };
});

afterEach(() => {
  upstream = () => undefined;
});

// Probes call the provider through the Worker's own HttpClient: a harness whose outbound answers come from `probeReply`.
let probeReply: MockHandler = () => ({ status: 599 });

const probing = makeHarness((request) => probeReply(request));

const withoutUsage = makeHarness(undefined, { USAGE: undefined as unknown as D1Database });

const orgsHarness = makeHarness(undefined, isolatedPlatform().bindings);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await harness.dispose();
  await withoutUsage.dispose();
  await probing.dispose();
  await orgsHarness.dispose();
});

/** `fetch` that answers through the harness (an admin's Access token is added). */
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

/** The generated client; `Fetch` is read per request, so it is provided around the whole test (`through`). */
const client = HttpApiClient.make(ManagementApi, { baseUrl: "https://commissary.test" });

const through = (target: Harness) =>
  Effect.provide(
    Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetchVia(target))),
  );

beforeEach(async () => {
  await resetControlPlane();
  await resetUsageDb();
});

/** Imports a Claude auth file into the ControlPlane. */
const seed = (name: string, extra: Record<string, unknown> = {}) =>
  Effect.promise(async () => {
    await controlPlane()
      .models()
      .importAuthFile(name, JSON.stringify(claudeFile(extra)), {}, FULL_ACCESS);
  });

describe("management contract", () => {
  it.effect("decodes Spend limits and the calendar, and refuses a stale revision", () =>
    Effect.gen(function* () {
      const api = yield* client;

      const empty = yield* api.spend.overview();

      assert.deepStrictEqual(
        [empty.time_zone, empty.week_start, empty.limits.length],
        ["UTC", "monday", 0],
      );

      const created = yield* api.spend.create({
        payload: { kind: "org", subject: "", period: "month", amount_micros: 50_000_000 },
      });

      assert.deepStrictEqual(
        [created.kind, created.label, created.source, created.revision, created.spent_micros],
        ["org", "Whole org", "admin", 1, 0],
      );
      assert.strictEqual(created.remaining_micros, 50_000_000);

      const updated = yield* api.spend.update({
        params: { id: created.id },
        headers: { "if-match": "1" },
        payload: { amount_micros: 75_000_000 },
      });

      assert.deepStrictEqual([updated.amount_micros, updated.revision], [75_000_000, 2]);

      const stale = yield* Effect.flip(
        api.spend.update({
          params: { id: created.id },
          headers: { "if-match": "1" },
          payload: { amount_micros: 1 },
        }),
      );

      assert.instanceOf(stale, ManagementError);
      assert.strictEqual(stale.error, "conflict");

      const settings = yield* api.spend.settings({
        payload: { time_zone: "Europe/Berlin", week_start: "sunday" },
      });

      assert.deepStrictEqual(
        [settings.time_zone, settings.week_start],
        ["Europe/Berlin", "sunday"],
      );

      const removed = yield* api.spend.remove({
        params: { id: created.id },
        headers: { "if-match": "2" },
      });

      assert.strictEqual(removed.id, created.id);
      assert.strictEqual((yield* api.spend.overview()).limits.length, 0);
      yield* api.spend.settings({ payload: { time_zone: "UTC", week_start: "monday" } });
    }).pipe(through(harness)),
  );

  it.effect("decodes the credential list", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await controlPlane()
          .models()
          .importAuthFile("claude-a.json", JSON.stringify(claudeFile()), {}, FULL_ACCESS);
        await controlPlane()
          .models()
          .importAuthFile(
            "claude-b.json",
            JSON.stringify(
              claudeFile({ email: "b@x.com", priority: 2, note: "backup", disabled: true }),
            ),
            {},
            FULL_ACCESS,
          );
      });

      const api = yield* client;
      const { files } = yield* api.credentials.list();

      assert.deepStrictEqual(
        files.map((file) => [file.name, file.provider, file.email, file.disabled]),
        [
          ["claude-a.json", "claude", "me@x.com", false],
          ["claude-b.json", "claude", "b@x.com", true],
        ],
      );
      assert.strictEqual(files[1]?.priority, 2);
      assert.strictEqual(files[1]?.note, "backup");
      assert.strictEqual(files[0]?.recent_requests.length, 20);
    }).pipe(through(harness)),
  );

  it.effect("decodes usage summaries for every group key", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        const db = await resetUsageDb();
        await insertUsageRecord(db, sampleRecord());
        await insertUsageRecord(db, sampleRecord({ model: "gpt-5-mini", failed: true }));
      });

      const api = yield* client;

      for (const groupBy of UsageGroupBy.literals) {
        const summary = yield* api.usage.summary({
          // `all`: a toolkit or tool grouping reads tool calls only by default, and these are model attempts.
          query: { group_by: groupBy, since: 1_600_000_000_000, area: "all" },
        });

        assert.strictEqual(summary.group_by, groupBy);
        assert.strictEqual(summary.totals.requests, 2);
        assert.strictEqual(summary.totals.failed, 1);
      }

      const byModel = yield* api.usage.summary({ query: { group_by: "model", model: "gpt-5" } });
      assert.deepStrictEqual(
        byModel.groups.map((group) => [group.key, group.requests]),
        [["gpt-5", 1]],
      );
    }).pipe(through(harness)),
  );

  it.effect("decodes the cost of usage in summaries, series, records and the unpriced list", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        const db = await resetUsageDb();

        await insertUsageRecord(
          db,
          sampleRecord({ requestId: "p", cost: { micros: 2_500, unpriced: false } }),
        );

        await insertUsageRecord(
          db,
          sampleRecord({
            requestId: "u",
            requestedAt: 1_700_000_001_000,
            model: "mystery",
            cost: { micros: 0, unpriced: true },
          }),
        );
      });

      const api = yield* client;
      const since = 1_600_000_000_000;
      const summary = yield* api.usage.summary({ query: { group_by: "model", since } });

      assert.strictEqual(summary.totals.cost_micros, 2_500);
      assert.strictEqual(summary.totals.unpriced_requests, 1);

      assert.deepStrictEqual(
        summary.groups.map((group) => [group.key, group.cost_micros, group.unpriced_requests]),
        [
          ["gpt-5", 2_500, 0],
          ["mystery", 0, 1],
        ],
      );

      const series = yield* api.usage.series({
        query: { since: 1_700_000_000_000 - 3_600_000, until: 1_700_000_000_000 + 3_600_000 },
      });

      assert.strictEqual(series.series[0]?.points[0]?.cost_micros, 2_500);

      const page = yield* api.usage.records({ query: {} });

      assert.deepStrictEqual(
        page.records.map((record) => [record.request_id, record.cost_micros, record.unpriced]),
        [
          ["u", 0, true],
          ["p", 2_500, false],
        ],
      );

      const unpriced = yield* api.usage.unpriced({ query: { since } });

      assert.deepStrictEqual(unpriced, {
        models: [{ provider: "codex", model: "mystery", requests: 1, total_tokens: 130 }],
      });

      // The list narrows like the rest of the page: by account and by user.
      const nobody = yield* api.usage.unpriced({
        query: { since, principal: "nobody@example.com" },
      });

      const noAccount = yield* api.usage.unpriced({
        query: { since, auth_index: "0000000000000000" },
      });

      assert.deepStrictEqual(nobody, { models: [] });
      assert.deepStrictEqual(noAccount, { models: [] });
    }).pipe(through(harness)),
  );

  describe("usage records", () => {
    const seedRecords = Effect.promise(async () => {
      const db = await resetUsageDb();
      const base = 1_700_000_000_000;
      await insertUsageRecord(db, sampleRecord({ requestId: "r1", requestedAt: base }));
      await insertUsageRecord(
        db,
        sampleRecord({
          requestId: "r2",
          requestedAt: base + 1000,
          authId: "codex-b.json",
          failed: true,
          fail: { statusCode: 429, type: "rate_limit_error", code: "rate_limited" },
        }),
      );
      await insertUsageRecord(db, sampleRecord({ requestId: "r3", requestedAt: base + 2000 }));
    });

    it.effect("decodes records newest first", () =>
      Effect.gen(function* () {
        yield* seedRecords;
        const api = yield* client;
        const page = yield* api.usage.records({ query: {} });

        assert.deepStrictEqual(
          page.records.map((record) => record.request_id),
          ["r3", "r2", "r1"],
        );
        assert.strictEqual(page.next_before, undefined);

        const first = page.records[2];
        assert.strictEqual(first?.api_key, "user:dev@example.com");
        assert.strictEqual(first?.failed, false);
        assert.deepStrictEqual(first?.fail, { status_code: 200 });
        assert.strictEqual(first?.token_breakdown.output.reasoning_tokens, 12);
        assert.strictEqual(first?.trace_id, "trace-1");
      }).pipe(through(harness)),
    );

    it.effect("filters failed records with their status, type and code", () =>
      Effect.gen(function* () {
        yield* seedRecords;
        const api = yield* client;
        const page = yield* api.usage.records({ query: { failed: "true" } });

        assert.strictEqual(page.records.length, 1);
        assert.strictEqual(page.records[0]?.request_id, "r2");
        assert.strictEqual(page.records[0]?.failed, true);
        assert.deepStrictEqual(page.records[0]?.fail, {
          status_code: 429,
          type: "rate_limit_error",
          code: "rate_limited",
        });

        const ok = yield* api.usage.records({ query: { failed: "false" } });
        assert.deepStrictEqual(
          ok.records.map((record) => record.request_id),
          ["r3", "r1"],
        );
      }).pipe(through(harness)),
    );

    it.effect("pages with limit and next_before", () =>
      Effect.gen(function* () {
        yield* seedRecords;
        const api = yield* client;
        const first = yield* api.usage.records({ query: { limit: 2 } });

        assert.deepStrictEqual(
          first.records.map((record) => record.request_id),
          ["r3", "r2"],
        );
        assert.isDefined(first.next_before);

        const second = yield* api.usage.records({
          query: { limit: 2, before: first.next_before ?? "" },
        });

        assert.deepStrictEqual(
          second.records.map((record) => record.request_id),
          ["r1"],
        );
        assert.strictEqual(second.next_before, undefined);
      }).pipe(through(harness)),
    );

    it.effect("filters by auth_index", () =>
      Effect.gen(function* () {
        yield* seedRecords;
        const api = yield* client;

        const page = yield* api.usage.records({
          query: { auth_index: authIndexOf("codex-a.json") },
        });

        assert.deepStrictEqual(
          page.records.map((record) => record.request_id),
          ["r3", "r1"],
        );
      }).pipe(through(harness)),
    );
  });

  it("lists the same group keys as the D1 summary", () => {
    assert.deepStrictEqual([...UsageGroupBy.literals], [...GROUP_BY]);
  });

  it.effect("decodes error bodies into ManagementError", () =>
    Effect.gen(function* () {
      const api = yield* client;
      const error = yield* Effect.flip(api.usage.summary({ query: {} }));

      assert.instanceOf(error, ManagementError);
      assert.strictEqual(error.error, "usage store unavailable");
    }).pipe(through(withoutUsage)),
  );

  describe("credential mutations", () => {
    it.effect("setDisabled toggles the flag and a missing file is a 404", () =>
      Effect.gen(function* () {
        yield* seed("a.json");
        const api = yield* client;

        const off = yield* api.credentials.setDisabled({
          payload: { name: "a.json", disabled: true },
        });

        assert.deepStrictEqual(off, { status: "ok", disabled: true });
        assert.strictEqual((yield* api.credentials.list()).files[0]?.disabled, true);

        const on = yield* api.credentials.setDisabled({
          payload: { name: "a.json", disabled: false },
        });

        assert.deepStrictEqual(on, { status: "ok", disabled: false });
        assert.strictEqual((yield* api.credentials.list()).files[0]?.disabled, false);

        const error = yield* Effect.flip(
          api.credentials.setDisabled({ payload: { name: "ghost.json", disabled: true } }),
        );

        assert.instanceOf(error, ManagementError);
        assert.strictEqual(error.error, "auth file not found");
      }).pipe(through(harness)),
    );

    it.effect("patchFields sets, clears and rejects fields", () =>
      Effect.gen(function* () {
        yield* seed("a.json");
        const api = yield* client;

        assert.deepStrictEqual(
          yield* api.credentials.patchFields({
            payload: { name: "a.json", priority: 5, note: "primary", weight: 3, request_retry: 2 },
          }),
          { status: "ok" },
        );

        const set = (yield* api.credentials.list()).files[0];
        assert.strictEqual(set?.priority, 5);
        assert.strictEqual(set?.note, "primary");
        assert.strictEqual(set?.weight, 3);
        assert.strictEqual(set?.request_retry, 2);

        yield* api.credentials.patchFields({
          payload: { name: "a.json", priority: null, note: null, request_retry: null },
        });

        const cleared = (yield* api.credentials.list()).files[0];
        assert.strictEqual(cleared?.priority, undefined);
        assert.strictEqual(cleared?.note, undefined);
        assert.strictEqual(cleared?.request_retry, undefined);

        const invalid = yield* Effect.flip(
          api.credentials.patchFields({ payload: { name: "a.json", weight: 2_000_000 } }),
        );

        assert.instanceOf(invalid, ManagementError);
        assert.strictEqual(invalid.path, "weight");

        const missing = yield* Effect.flip(
          api.credentials.patchFields({ payload: { name: "ghost.json", note: "x" } }),
        );

        assert.instanceOf(missing, ManagementError);
        assert.strictEqual(missing.error, "auth file not found");
      }).pipe(through(harness)),
    );

    it.effect("patchFields edits the routing fields and names a refused one", () =>
      Effect.gen(function* () {
        yield* seed("r.json", { headers: { Authorization: "Bearer sk-ant-api-secret-4321" } });
        const api = yield* client;

        const before = (yield* api.credentials.list()).files[0];
        assert.deepStrictEqual(before?.headers, { Authorization: "[redacted]\u20264321" });

        yield* api.credentials.patchFields({
          payload: {
            name: "r.json",
            prefix: "team",
            disable_cooling: false,
            headers: { Authorization: "[redacted]\u20264321", "User-Agent": "blue" },
            excluded_models: ["Claude-3-*"],
            model_aliases: [{ name: "claude-opus-4-5", alias: "opus", fork: true }],
          },
        });

        const after = (yield* api.credentials.list()).files[0];
        assert.strictEqual(after?.prefix, "team");
        assert.strictEqual(after?.disable_cooling, false);
        assert.deepStrictEqual(after?.headers, {
          Authorization: "[redacted]\u20264321",
          "User-Agent": "blue",
        });
        assert.deepStrictEqual(after?.excluded_models, ["claude-3-*"]);
        assert.deepStrictEqual(after?.model_aliases, [
          { name: "claude-opus-4-5", alias: "opus", fork: true },
        ]);

        const refused = yield* Effect.flip(
          api.credentials.patchFields({
            payload: { name: "r.json", model_aliases: [{ name: "a", alias: "a" }] },
          }),
        );

        assert.instanceOf(refused, ManagementError);
        assert.strictEqual(refused.path, "model_aliases.0");
      }).pipe(through(harness)),
    );

    it.effect("refresh answers the fresh entry without a refresh token", () =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await controlPlane()
            .models()
            .importAuthFile(
              "noref.json",
              JSON.stringify({ type: "claude", email: "n@x.com", access_token: "t" }),
              {},
              FULL_ACCESS,
            );
        });
        const api = yield* client;
        const refreshed = yield* api.credentials.refresh({ payload: { name: "noref.json" } });

        assert.strictEqual(refreshed.ok, true);
        assert.strictEqual(refreshed.auth.name, "noref.json");
        assert.strictEqual(refreshed.auth.email, "n@x.com");

        const error = yield* Effect.flip(
          api.credentials.refresh({ payload: { name: "ghost.json" } }),
        );

        assert.instanceOf(error, ManagementError);
        assert.strictEqual(error.error, "auth file not found");
      }).pipe(through(harness)),
    );

    it.effect("refresh with a mocked token endpoint decodes the entry", () =>
      Effect.gen(function* () {
        upstream = ({ method, url }) =>
          `${method} ${url}` === "POST https://platform.claude.com/v1/oauth/token"
            ? Response.json({
                access_token: "new-access",
                refresh_token: "new-refresh",
                expires_in: 3600,
              })
            : undefined;
        yield* seed("a.json");
        const api = yield* client;
        const refreshed = yield* api.credentials.refresh({ payload: { name: "a.json" } });

        assert.strictEqual(refreshed.auth.name, "a.json");
        assert.strictEqual(refreshed.auth.recent_requests.length, 20);
      }).pipe(through(harness)),
    );

    it.effect("resetCooldown answers the cleared models and a missing index is a 404", () =>
      Effect.gen(function* () {
        yield* seed("a.json");
        const api = yield* client;
        const entry = (yield* api.credentials.list()).files[0];
        assert.isDefined(entry);

        const reset = yield* api.credentials.resetCooldown({
          payload: { auth_index: entry?.auth_index ?? "" },
        });

        assert.strictEqual(reset.status, "ok");
        assert.strictEqual(reset.auth_index, entry?.auth_index);
        assert.isArray(reset.models);

        const error = yield* Effect.flip(
          api.credentials.resetCooldown({ payload: { auth_index: "0000000000000000" } }),
        );

        assert.instanceOf(error, ManagementError);
        assert.strictEqual(error.error, "auth not found");
      }).pipe(through(harness)),
    );

    it.effect("remove deletes one credential and a missing one is a 404", () =>
      Effect.gen(function* () {
        yield* seed("a.json");
        yield* seed("b.json", { email: "b@x.com" });
        const api = yield* client;

        assert.deepStrictEqual(yield* api.credentials.remove({ query: { name: "a.json" } }), {
          status: "ok",
        });
        assert.deepStrictEqual(
          (yield* api.credentials.list()).files.map((file) => file.name),
          ["b.json"],
        );

        const error = yield* Effect.flip(api.credentials.remove({ query: { name: "a.json" } }));
        assert.instanceOf(error, ManagementError);
        assert.strictEqual(error.error, "auth file not found");
      }).pipe(through(harness)),
    );

    it.effect("upload sends the JSON text and rejects an invalid file", () =>
      Effect.gen(function* () {
        const api = yield* client;

        assert.deepStrictEqual(
          yield* api.credentials.upload({
            query: { name: "up.json" },
            payload: JSON.stringify(claudeFile({ email: "up@x.com" })),
          }),
          { status: "ok" },
        );

        const files = (yield* api.credentials.list()).files;
        assert.deepStrictEqual(
          files.map((file) => [file.name, file.email]),
          [["up.json", "up@x.com"]],
        );

        const notJson = yield* Effect.flip(
          api.credentials.upload({ query: { name: "bad.json" }, payload: "not json" }),
        );

        assert.instanceOf(notJson, ManagementError);
        assert.include(notJson.error, "invalid auth file");

        const noType = yield* Effect.flip(
          api.credentials.upload({ query: { name: "bad.json" }, payload: "{}" }),
        );

        assert.instanceOf(noType, ManagementError);

        const badName = yield* Effect.flip(
          api.credentials.upload({
            query: { name: "bad.txt" },
            payload: JSON.stringify(claudeFile()),
          }),
        );

        assert.instanceOf(badName, ManagementError);
      }).pipe(through(harness)),
    );

    it.effect("models decodes the registry's list and rejects an empty name", () =>
      Effect.gen(function* () {
        yield* seed("a.json");
        const api = yield* client;
        const { models } = yield* api.credentials.models({ query: { name: "a.json" } });

        assert.isArray(models);

        const error = yield* Effect.flip(api.credentials.models({ query: { name: "" } }));
        assert.instanceOf(error, ManagementError);
        assert.strictEqual(error.error, "name is required");
      }).pipe(through(harness)),
    );
  });

  describe("model catalog", () => {
    it.effect("status and refresh decode; a refused refresh is a ManagementError", () =>
      Effect.gen(function* () {
        probeReply = () => ({ status: 200, body: documentText() });
        yield* Effect.promise(() => env.CACHE.delete(CATALOG_KEYS.modelsDev));
        yield* Effect.promise(() => env.CACHE.delete(CATALOG_KEYS.status));

        const api = yield* client;
        const before = yield* api.catalog.status();

        assert.strictEqual(before.mode, "official");
        assert.isFalse(before.stored);

        const refreshed = yield* api.catalog.refresh();

        assert.strictEqual(refreshed.status, "updated");
        assert.isTrue(refreshed.catalog.stored);
        assert.strictEqual(refreshed.catalog.last_attempt?.status, "updated");
        assert.strictEqual((yield* api.catalog.refresh()).status, "unchanged");

        yield* Effect.promise(async () => {
          assert.isTrue(
            (await controlPlane().models().importConfig("models:\n  catalog: embed\n", "test")).ok,
          );
        });
        const refused = yield* Effect.flip(api.catalog.refresh());

        assert.instanceOf(refused, ManagementError);
        assert.strictEqual(refused.error, "catalog_not_fetched");
      }).pipe(through(probing)),
    );
  });

  describe("routing", () => {
    const aliases = [{ name: "claude-sonnet-4-6", alias: "s46" }];

    it.effect("models decodes accounts and provider keys with their routes", () =>
      Effect.gen(function* () {
        yield* seed("claude-a.json");
        yield* Effect.promise(async () => {
          const result = await controlPlane()
            .models()
            .importConfig(
              JSON.stringify({
                "api-keys": {
                  claude: [
                    {
                      "base-url": "https://api.anthropic.com",
                      "excluded-models": ["claude-opus-*"],
                      keys: [{ "api-key": "sk-ant-one" }],
                    },
                  ],
                },
              }),
              "test",
            );

          assert.isTrue(result.ok);
        });

        const api = yield* client;
        const view = yield* api.routing.models();
        const entry = (yield* api.credentials.list()).files[0];

        assert.isAbove(view.config_version, 0);
        assert.strictEqual(view.force_model_prefix, false);
        assert.deepStrictEqual(view.channels, [{ channel: "claude", accounts: 1 }]);

        const sonnet = view.models.find((model) => model.id === "claude-sonnet-4-6");
        assert.isDefined(sonnet);
        assert.strictEqual(sonnet?.listed, true);
        assert.strictEqual(sonnet?.routes.length, 2);

        const file = sonnet?.routes.find((route) => route.source === "file");
        assert.strictEqual(file?.auth_index, entry?.auth_index);
        assert.strictEqual(file?.name, "claude-a.json");
        assert.strictEqual(file?.channel, "claude");
        assert.strictEqual(file?.state, "available");

        const config = sonnet?.routes.find((route) => route.source === "config");
        assert.isDefined(config);
        assert.strictEqual(config?.channel, undefined);
        assert.strictEqual(config?.state, "available");

        const opus = view.models.find((model) => model.id === "claude-opus-4-6");
        const excluded = opus?.routes.find((route) => route.source === "config");
        assert.strictEqual(excluded?.state, "excluded");
        assert.strictEqual(excluded?.reason, "claude-opus-*");
        assert.strictEqual(excluded?.rule_scope, "key");
        assert.strictEqual(opus?.listed, true);
      }).pipe(through(harness)),
    );

    it.effect("a rule edit at the channel's revision shows in the next read", () =>
      Effect.gen(function* () {
        yield* seed("claude-a.json");
        const api = yield* client;
        const before = yield* api.routing.models();
        assert.isUndefined(before.models.find((model) => model.id === "s46"));

        assert.deepStrictEqual(before.revisions, { aliases: {}, exclusions: {} });

        const saved = yield* api.routing.putAliases({
          params: { channel: "claude" },
          headers: { "if-match": "0" },
          payload: aliases,
        });

        assert.strictEqual(saved.status, "ok");
        assert.isAbove(saved.version, before.config_version);

        const after = yield* api.routing.models();
        assert.strictEqual(after.config_version, saved.version);
        assert.deepStrictEqual(after.aliases, { claude: aliases });
        assert.deepStrictEqual(after.revisions.aliases, { claude: saved.revision });

        const aliased = after.models.find((model) => model.id === "s46");
        assert.strictEqual(aliased?.routes[0]?.via, "alias");
        assert.strictEqual(aliased?.routes[0]?.upstream, "claude-sonnet-4-6");
        assert.strictEqual(aliased?.routes[0]?.rule_scope, "channel");
        assert.isUndefined(after.models.find((model) => model.id === "claude-sonnet-4-6"));

        // The channel's exclusions are an entry of their own: no rules yet, revision 0.
        const excluded = yield* api.routing.putExclusions({
          params: { channel: "claude" },
          headers: { "if-match": "0" },
          payload: ["claude-opus-*"],
        });

        const hidden = (yield* api.routing.models()).models.find(
          (model) => model.id === "claude-opus-4-6",
        );

        assert.strictEqual(excluded.version, saved.version + 1);
        assert.strictEqual(hidden?.listed, false);
        assert.strictEqual(hidden?.routes[0]?.state, "excluded");
        assert.strictEqual(hidden?.routes[0]?.rule_scope, "channel");

        const removed = yield* api.routing.deleteExclusions({
          params: { channel: "claude" },
          headers: { "if-match": `W/"${excluded.revision}"` },
        });

        assert.strictEqual(removed.version, excluded.version + 1);
        assert.strictEqual(removed.revision, 0);
        assert.deepStrictEqual((yield* api.routing.models()).excluded, {});
      }).pipe(through(harness)),
    );

    it.effect("a stale revision is a 409 ManagementError and stores nothing", () =>
      Effect.gen(function* () {
        const api = yield* client;

        yield* api.routing.putAliases({
          params: { channel: "claude" },
          headers: { "if-match": "0" },
          payload: aliases,
        });

        const error = yield* Effect.flip(
          api.routing.putAliases({
            params: { channel: "claude" },
            headers: { "if-match": "0" },
            payload: [{ name: "claude-opus-4-6", alias: "lost" }],
          }),
        );

        assert.instanceOf(error, ManagementError);
        assert.strictEqual(error.error, "conflict");
        assert.deepStrictEqual((yield* api.routing.models()).aliases, { claude: aliases });

        const staleDelete = yield* Effect.flip(
          api.routing.deleteAliases({
            params: { channel: "claude" },
            headers: { "if-match": "0" },
          }),
        );

        assert.instanceOf(staleDelete, ManagementError);
        assert.strictEqual(staleDelete.error, "conflict");
      }).pipe(through(harness)),
    );

    it.effect("deleting a channel without rules is a 404 not_found", () =>
      Effect.gen(function* () {
        const api = yield* client;
        const headers = { "if-match": "0" };

        for (const remove of [api.routing.deleteAliases, api.routing.deleteExclusions]) {
          const error = yield* Effect.flip(remove({ params: { channel: "claude" }, headers }));

          assert.instanceOf(error, ManagementError);
          assert.strictEqual(error.error, "not_found");
        }
      }).pipe(through(harness)),
    );
  });

  describe("oauth", () => {
    it.effect("start answers a callback flow's authorize URL, pending status and cancel", () =>
      Effect.gen(function* () {
        const api = yield* client;
        const started = yield* api.oauth.start({ query: { provider: "claude" } });

        assert.strictEqual(started.status, "ok");
        assert.strictEqual(new URL(started.url).hostname, "claude.ai");
        assert.isAbove(started.state.length, 0);
        assert.strictEqual(started.flow, undefined);

        assert.deepStrictEqual(yield* api.oauth.status({ query: { state: started.state } }), {
          status: "wait",
        });
        assert.deepStrictEqual(yield* api.oauth.cancel({ query: { state: started.state } }), {
          status: "ok",
          cancelled: true,
        });
        assert.deepStrictEqual(yield* api.oauth.status({ query: { state: started.state } }), {
          status: "error",
          error: "unknown or expired state",
        });
      }).pipe(through(harness)),
    );

    it.effect("start answers a device flow with a user code", () =>
      Effect.gen(function* () {
        upstream = ({ method, url }) => {
          const key = `${method} ${url}`;

          if (key === "GET https://auth.x.ai/.well-known/openid-configuration") {
            return Response.json({
              device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
              token_endpoint: "https://auth.x.ai/oauth2/token",
            });
          }

          return key === "POST https://auth.x.ai/oauth2/device/code"
            ? Response.json({
                device_code: "dc",
                user_code: "UC-1",
                verification_uri: "https://x.ai/device",
                expires_in: 900,
              })
            : undefined;
        };

        const api = yield* client;
        const started = yield* api.oauth.start({ query: { provider: "xai" } });

        assert.strictEqual(started.flow, "device");
        assert.strictEqual(started.url, "https://x.ai/device");
        assert.strictEqual(started.user_code, "UC-1");
        assert.strictEqual(started.expires_in, 900);
        assert.deepStrictEqual(yield* api.oauth.status({ query: { state: started.state } }), {
          status: "wait",
        });
      }).pipe(through(harness)),
    );

    it.effect("status of an unknown state is an error progress, not a failure", () =>
      Effect.gen(function* () {
        const api = yield* client;

        assert.deepStrictEqual(yield* api.oauth.status({ query: { state: "nope-123" } }), {
          status: "error",
          error: "unknown or expired state",
        });
      }).pipe(through(harness)),
    );

    it.effect("cancel of an unknown state answers cancelled: false", () =>
      Effect.gen(function* () {
        const api = yield* client;
        const cancelled = yield* api.oauth.cancel({ query: { state: "nope-123" } });

        assert.strictEqual(cancelled.status, "ok");
        assert.strictEqual(cancelled.cancelled, false);
      }).pipe(through(harness)),
    );

    it.effect("callback with a malformed redirect_url is a ManagementError", () =>
      Effect.gen(function* () {
        const api = yield* client;

        const unparsable = yield* Effect.flip(
          api.oauth.callback({ payload: { provider: "claude", redirect_url: "http://" } }),
        );

        assert.instanceOf(unparsable, ManagementError);
        assert.strictEqual(unparsable.error, "invalid redirect_url");

        // A pasted string that parses (relative to localhost) but carries no state is rejected too.
        const stateless = yield* Effect.flip(
          api.oauth.callback({ payload: { provider: "claude", redirect_url: "not a url" } }),
        );

        assert.instanceOf(stateless, ManagementError);
        assert.strictEqual(stateless.error, "state is required");
      }).pipe(through(harness)),
    );
  });

  describe("api keys", () => {
    const SECRETS = [
      "sk-ant-AAAA1111",
      "sk-ant-BBBB2222",
      "sk-codex-CCCC3333",
      "sk-acme-DDDD4444",
      "hdr-secret-9876",
    ];

    const seedKeys = (extra: Record<string, unknown> = {}) =>
      Effect.promise(async () => {
        await controlPlane()
          .models()
          .importConfig(
            JSON.stringify({
              "api-keys": {
                claude: [
                  {
                    name: "main",
                    "base-url": "https://api.anthropic.com",
                    "proxy-url": "http://127.0.0.1:9",
                    headers: {
                      "X-Api-Key": "hdr-secret-9876",
                      "X-Team": "blue",
                      "X-Sid": "$CPA-SESSION-ID-sk-live-1234abcd",
                      "X-Copy": "$x-team",
                    },
                    keys: [{ "api-key": SECRETS[0] }, { "api-key": SECRETS[1], weight: 3 }],
                  },
                ],
                codex: [
                  {
                    "base-url": "https://codex.test/backend-api/codex",
                    keys: [{ "api-key": SECRETS[2] }],
                  },
                ],
                "openai-compatibility": [
                  {
                    name: "acme",
                    "base-url": "https://api.acme.test/v1",
                    keys: [{ "api-key": SECRETS[3] }],
                  },
                ],
                ...extra,
              },
            }),
            "test",
          );
      });

    const claudeGroup = (list: ProviderKeysList): GroupView => {
      const group = list.families.claude[0];

      assert.isDefined(group);

      return group!;
    };

    /** The claude group as an input that keeps every key (by `auth_index`) and every field. */
    const claudeInput = (view: GroupView) => ({
      ...(view.group.name === undefined ? {} : { name: view.group.name }),
      ...(view.group["base-url"] === undefined ? {} : { "base-url": view.group["base-url"] }),
      ...(view.group.headers === undefined ? {} : { headers: view.group.headers }),
      keys: view.group.keys.map((key) => ({
        auth_index: key.auth_index!,
        ...(key.weight === undefined ? {} : { weight: key.weight }),
      })),
    });

    const storedDocument = () =>
      Effect.promise(async () => (await controlPlane().models().getConfig()).document ?? "");

    it.effect("lists groups with runtime state and never a secret", () =>
      Effect.gen(function* () {
        yield* seedKeys();
        const api = yield* client;
        const list = yield* api.providerKeys.list();
        const claude = claudeGroup(list);

        assert.strictEqual(claude.group.keys.length, 2);
        assert.strictEqual(claude.effective_base_url, "https://api.anthropic.com");
        assert.deepStrictEqual(
          claude.group.keys.map((key) => key.key_preview),
          ["[redacted]…1111", "[redacted]…2222"],
        );
        assert.strictEqual(claude.group.keys[1]?.weight, 3);
        assert.strictEqual(
          claude.group.keys[0]?.runtime?.auth_index,
          claude.group.keys[0]?.auth_index,
        );
        assert.strictEqual(claude.group.keys[0]?.runtime?.success, 0);
        // Every header value is masked except safe headers: a secret can sit under any name.
        assert.deepStrictEqual(claude.group.headers, {
          "X-Api-Key": "[redacted]…9876",
          "X-Team": "[redacted]",
          // A session template is a secret; a pure client copy is shown.
          "X-Sid": "[redacted]…abcd",
          "X-Copy": "$x-team",
        });
        // The hidden proxy is reported as a warning only.
        assert.strictEqual(claude.warnings.length, 1);
        assert.strictEqual(list.families.codex.length, 1);
        assert.strictEqual(list.families["openai-compatibility"][0]?.group.name, "acme");
        assert.strictEqual(list.families["openai-compatibility"][0]?.group.keys.length, 1);

        const raw = yield* Effect.promise(async () =>
          (await harness.call("/v9/management/provider-keys")).text(),
        );

        for (const secret of SECRETS) assert.notInclude(raw, secret);
        assert.notInclude(raw, "127.0.0.1:9");
      }).pipe(through(harness)),
    );

    it.effect("a write keeps stored keys by auth_index and replaces a key given a new secret", () =>
      Effect.gen(function* () {
        yield* seedKeys();
        const api = yield* client;
        const before = yield* api.providerKeys.list();
        const view = claudeGroup(before);
        const [kept, replaced] = view.group.keys;

        const written = yield* api.providerKeys.putGroup({
          payload: {
            family: "claude",
            id: view.id,
            revision: view.revision,
            group: {
              ...claudeInput(view),
              keys: [
                { auth_index: kept!.auth_index!, priority: 5 },
                { "api-key": "sk-ant-NEW33333", weight: 3 },
              ],
            },
          },
        });

        assert.isAbove(written.version, before.version);
        assert.strictEqual(written.id, view.id);
        assert.isAbove(written.revision, view.revision);

        const after = yield* api.providerKeys.list();
        const keys = claudeGroup(after).group.keys;

        assert.strictEqual(after.version, written.version);
        assert.strictEqual(claudeGroup(after).revision, written.revision);
        assert.strictEqual(keys[0]?.auth_index, kept?.auth_index);
        assert.strictEqual(keys[0]?.runtime?.auth_index, kept?.runtime?.auth_index);
        assert.strictEqual(keys[0]?.priority, 5);
        assert.strictEqual(keys[1]?.key_preview, "[redacted]…3333");
        assert.notStrictEqual(keys[1]?.auth_index, replaced?.auth_index);

        // Hidden settings and masked headers are carried over from the stored entry.
        const document = yield* storedDocument();

        assert.include(document, "http://127.0.0.1:9");
        assert.include(document, "hdr-secret-9876");
        assert.include(document, "sk-ant-NEW33333");
        assert.notInclude(document, "sk-ant-BBBB2222");
      }).pipe(through(harness)),
    );

    it.effect(
      "refuses a stale revision, an unknown auth_index and a group the config would drop",
      () =>
        Effect.gen(function* () {
          yield* seedKeys();
          const api = yield* client;
          const before = yield* api.providerKeys.list();
          const view = claudeGroup(before);

          const first = yield* api.providerKeys.putGroup({
            payload: {
              family: "claude",
              id: view.id,
              revision: view.revision,
              group: claudeInput(view),
            },
          });

          const stale = yield* Effect.flip(
            api.providerKeys.putGroup({
              payload: {
                family: "claude",
                id: view.id,
                revision: view.revision,
                group: claudeInput(view),
              },
            }),
          );

          assert.instanceOf(stale, ManagementError);
          assert.strictEqual(stale.error, "conflict");

          const current = (yield* api.providerKeys.list()).version;

          const unknown = yield* Effect.flip(
            api.providerKeys.putGroup({
              payload: {
                family: "claude",
                id: view.id,
                revision: first.revision,
                group: { ...claudeInput(view), keys: [{ auth_index: "0000000000000000" }] },
              },
            }),
          );

          assert.instanceOf(unknown, ManagementError);
          assert.strictEqual(unknown.error, "unknown_auth_index");

          const noBase = yield* Effect.flip(
            api.providerKeys.putGroup({
              payload: {
                family: "codex",
                revision: 0,
                group: { keys: [{ "api-key": "sk-codex-X" }] },
              },
            }),
          );

          assert.instanceOf(noBase, ManagementError);
          assert.isAbove(noBase.error.length, 0);

          // A group that is gone (or never was) is a conflict: the caller's view is out of date.
          const missing = yield* Effect.flip(
            api.providerKeys.deleteGroup({
              payload: { family: "claude", id: "group:missing", revision: 1 },
            }),
          );

          assert.instanceOf(missing, ManagementError);
          assert.strictEqual(missing.error, "conflict");

          // Nothing was stored by the refused writes.
          assert.strictEqual((yield* api.providerKeys.list()).version, current);
        }).pipe(through(harness)),
    );

    it.effect("drops a duplicate key silently, like a new one, and deletes a group", () =>
      Effect.gen(function* () {
        yield* seedKeys({ gemini: [{ keys: [{ "api-key": "gm-one" }] }] });
        const api = yield* client;
        const list = yield* api.providerKeys.list();

        // Silent: a duplicate of a stored key is accepted (and dropped), so the reply never confirms a guess.
        const duplicate = yield* api.providerKeys.putGroup({
          payload: {
            family: "gemini",
            revision: 0,
            group: { keys: [{ "api-key": "gm-one" }] },
          },
        });

        assert.deepStrictEqual(duplicate, {
          status: "ok",
          version: list.version + 1,
          id: duplicate.id,
          revision: list.version + 1,
        });
        const groups = (yield* api.providerKeys.list()).families.gemini;

        assert.strictEqual(groups.length, 1);
        const [only] = groups;

        const deleted = yield* api.providerKeys.deleteGroup({
          payload: { family: "gemini", id: only!.id, revision: only!.revision },
        });

        const after = yield* api.providerKeys.list();

        assert.strictEqual(after.version, deleted.version);
        assert.strictEqual(after.families.gemini.length, 0);
        assert.strictEqual(after.families.claude.length, 1);
      }).pipe(through(harness)),
    );

    it.effect(
      "setDisabled toggles a config key through excluded-models and refuses compat keys",
      () =>
        Effect.gen(function* () {
          yield* seedKeys();
          const api = yield* client;
          const view = claudeGroup(yield* api.providerKeys.list());
          const key = view.group.keys[0]!;

          const off = yield* api.credentials.setDisabled({
            payload: { auth_index: key.runtime!.auth_index, disabled: true },
          });

          assert.deepStrictEqual(off, {
            status: "ok",
            disabled: true,
            via: "config:excluded-models",
            excluded_pattern: "*",
          });

          const disabled = claudeGroup(yield* api.providerKeys.list()).group.keys[0]!;

          assert.strictEqual(disabled.disabled, true);
          assert.strictEqual(disabled.auth_index, key.auth_index);
          assert.deepStrictEqual(disabled["excluded-models"], ["*"]);

          yield* api.credentials.setDisabled({
            payload: { auth_index: key.auth_index!, disabled: false },
          });
          assert.strictEqual(
            claudeGroup(yield* api.providerKeys.list()).group.keys[0]?.disabled,
            false,
          );

          const compat = (yield* api.providerKeys.list()).families["openai-compatibility"][0]!.group
            .keys[0]!;

          const refused = yield* Effect.flip(
            api.credentials.setDisabled({
              payload: { auth_index: compat.runtime!.auth_index, disabled: true },
            }),
          );

          assert.instanceOf(refused, ManagementError);
          assert.include(refused.error, "disable the endpoint");
        }).pipe(through(harness)),
    );

    describe("probe", () => {
      beforeEach(() => {
        probing.requests.length = 0;
        probeReply = () => ({ status: 599 });
      });

      const authIndexOfFirst = (
        list: ProviderKeysList,
        family: "claude" | "codex" | "gemini" | "vertex",
      ) => list.families[family][0]!.group.keys[0]!.auth_index!;

      const probe = (authIndex: string) =>
        Effect.gen(function* () {
          const api = yield* client;

          return yield* api.providerKeys.probe({ payload: { auth_index: authIndex } });
        });

      it.effect("lists the models of each family with the family's authentication", () =>
        Effect.gen(function* () {
          yield* seedKeys({
            gemini: [{ "base-url": "https://gemini.test", keys: [{ "api-key": "gm-key-1234" }] }],
            vertex: [
              {
                "base-url": "https://vertex.test",
                models: [{ name: "gemini-2.5-pro", alias: "pro" }],
                keys: [{ "api-key": "vx-key-1234" }],
              },
            ],
          });

          const api = yield* client;
          const list = yield* api.providerKeys.list();
          const seen = probing.requests;

          probeReply = (request: RecordedRequest) => {
            const url = new URL(request.url);

            if (url.host === "api.anthropic.com")
              return { body: { data: [{ id: "claude-sonnet", display_name: "Claude Sonnet" }] } };

            if (url.host === "codex.test") return { body: { data: [{ id: "gpt-5-codex" }] } };

            if (url.host === "api.acme.test") return { body: { data: [{ id: "acme-1" }] } };

            if (url.host === "gemini.test")
              return url.searchParams.get("pageToken") === "p2"
                ? { body: { models: [{ name: "models/gemini-b" }] } }
                : {
                    body: {
                      models: [{ name: "models/gemini-a", displayName: "Gemini A" }],
                      nextPageToken: "p2",
                    },
                  };

            if (url.host === "vertex.test") return { body: { totalTokens: 1 } };

            return { status: 599 };
          };

          const claude = yield* probe(authIndexOfFirst(list, "claude"));

          assert.strictEqual(claude.ok, true);
          assert.deepStrictEqual(claude.models, [
            { id: "claude-sonnet", display_name: "Claude Sonnet" },
          ]);
          assert.strictEqual(seen[0]?.url, "https://api.anthropic.com/v1/models?limit=1000");
          assert.strictEqual(seen[0]?.headers["x-api-key"], SECRETS[0]);
          assert.isDefined(seen[0]?.headers["anthropic-version"]);
          // The configured headers go along, the authentication ones last.
          assert.strictEqual(seen[0]?.headers["x-team"], "blue");

          const codex = yield* probe(authIndexOfFirst(list, "codex"));

          assert.deepStrictEqual(codex.models, [{ id: "gpt-5-codex" }]);
          assert.strictEqual(seen[1]?.url, "https://codex.test/backend-api/codex/v1/models");
          assert.strictEqual(seen[1]?.headers.authorization, `Bearer ${SECRETS[2]}`);

          const compatKey = list.families["openai-compatibility"][0]!.group.keys[0]!;
          const compat = yield* probe(compatKey.auth_index!);

          assert.deepStrictEqual(compat.models, [{ id: "acme-1" }]);
          assert.strictEqual(seen[2]?.url, "https://api.acme.test/v1/models");

          const gemini = yield* probe(authIndexOfFirst(list, "gemini"));

          assert.deepStrictEqual(
            gemini.models?.map((model) => model.id),
            ["gemini-a", "gemini-b"],
          );
          assert.strictEqual(seen[3]?.headers["x-goog-api-key"], "gm-key-1234");
          assert.strictEqual(seen.length, 5);

          const vertex = yield* probe(authIndexOfFirst(list, "vertex"));

          assert.strictEqual(vertex.ok, true);

          const count = seen[5];

          assert.strictEqual(count?.method, "POST");
          assert.strictEqual(
            count?.url,
            "https://vertex.test/v1/publishers/google/models/gemini-2.5-pro:countTokens",
          );
          assert.strictEqual(count?.headers["x-goog-api-key"], "vx-key-1234");

          // A probe is not a request: the credential pool's counters stay untouched.
          const after = yield* api.providerKeys.list();

          for (const group of after.families.claude)
            for (const key of group.group.keys) {
              assert.strictEqual(key.runtime?.success, 0);
              assert.strictEqual(key.runtime?.failed, 0);
            }
        }).pipe(through(probing)),
      );

      it.effect("reports an upstream refusal without echoing the key or the body", () =>
        Effect.gen(function* () {
          yield* seedKeys();
          const api = yield* client;
          const list = yield* api.providerKeys.list();

          probeReply = () => ({ status: 401, body: { error: `invalid key ${SECRETS[0]}` } });

          const refused = yield* probe(authIndexOfFirst(list, "claude"));

          assert.strictEqual(refused.ok, false);
          assert.strictEqual(refused.status_code, 401);
          assert.isAtLeast(refused.latency_ms, 0);
          assert.notInclude(JSON.stringify(refused), SECRETS[0]!);
          assert.notInclude(JSON.stringify(refused), "invalid key");

          probeReply = () => ({ transportError: true });

          const unreachable = yield* probe(authIndexOfFirst(list, "codex"));

          assert.strictEqual(unreachable.ok, false);
          assert.strictEqual(unreachable.status_code, undefined);
          assert.isDefined(unreachable.error);

          const missing = yield* Effect.flip(probe("0000000000000000"));

          assert.instanceOf(missing, ManagementError);
          assert.strictEqual(missing.error, "api key not found");
        }).pipe(through(probing)),
      );
    });
  });

  describe("orgs", () => {
    it.effect("lists, creates and renames orgs and tells who the caller is", () =>
      Effect.gen(function* () {
        const api = yield* client;

        const me = yield* api.orgs.me();
        assert.isTrue(me.platform_admin);
        assert.deepStrictEqual(me.orgs[0], { slug: "default", name: "Default" });

        const created = yield* api.orgs.create({
          payload: { slug: "contract-org", name: "Contract" },
        });

        assert.strictEqual(created.slug, "contract-org");
        assert.match(created.id, /^org-[0-9a-f]{16}$/);

        const listed = yield* api.orgs.list();

        assert.deepStrictEqual(
          listed.orgs.map((org) => org.slug),
          ["default", "contract-org"],
        );

        const renamed = yield* api.orgs.update({
          params: { slug: "contract-org" },
          payload: { slug: "renamed-org", name: "Renamed" },
        });

        assert.deepStrictEqual(
          [renamed.id, renamed.slug, renamed.name],
          [created.id, "renamed-org", "Renamed"],
        );

        const taken = yield* Effect.flip(
          api.orgs.create({ payload: { slug: "renamed-org", name: "Again" } }),
        );

        assert.instanceOf(taken, ManagementError);
        assert.strictEqual(taken.error, "slug_taken");

        const missing = yield* Effect.flip(
          api.orgs.update({ params: { slug: "nobody" }, payload: { name: "X" } }),
        );

        assert.instanceOf(missing, ManagementError);
        assert.strictEqual(missing.error, "org_not_found");
      }).pipe(through(orgsHarness)),
    );

    it.effect("serves the other groups of an org under its slug", () =>
      Effect.gen(function* () {
        const api = yield* client;
        const created = yield* api.orgs.create({ payload: { slug: "contract-scoped", name: "S" } });

        // The panel's client addresses its org this way (apps/web/src/api/client.ts).
        const scoped = HttpApiClient.make(ManagementApi, {
          baseUrl: "https://commissary.test",
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.updateUrl((url) => scopedApiUrl(url, "contract-scoped")),
          ),
        });

        assert.strictEqual(created.slug, "contract-scoped");
        const list = yield* (yield* scoped).credentials.list();
        assert.deepStrictEqual(list.files, []);
      }).pipe(through(orgsHarness)),
    );
  });

  describe("settings", () => {
    it.effect("get decodes the view and save stores a patch", () =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await controlPlane()
            .models()
            .importConfig(
              JSON.stringify({
                access: { "api-keys": ["client-secret-key"] },
                "api-keys": {
                  claude: [
                    {
                      prefix: "team",
                      "base-url": "https://api.anthropic.com",
                      keys: [{ "api-key": "sk-ant-contract-secret" }],
                    },
                  ],
                },
              }),
              "test",
            );
        });
        const api = yield* client;
        const view = yield* api.settings.get();

        assert.deepStrictEqual(view.values, view.defaults);
        assert.deepStrictEqual(view.revisions, {});
        assert.strictEqual(view.prefixed_credentials, 1);
        assert.notInclude(JSON.stringify(view), "secret");

        const saved = yield* api.settings.save({
          payload: {
            revisions: view.revisions,
            patch: {
              routing: { strategy: "fill-first", retry: { "request-retry": 2 } },
              oauth: { providers: { antigravity: { "signature-bypass-strict": true } } },
            },
          },
        });

        const revision = view.version + 1;

        assert.deepStrictEqual(saved, {
          status: "ok",
          version: revision,
          revisions: {
            "routing.strategy": revision,
            "routing.retry.request-retry": revision,
            "oauth.providers.antigravity.signature-bypass-strict": revision,
          },
        });
        const after = yield* api.settings.get();

        assert.strictEqual(after.values.routing.strategy, "fill-first");
        assert.strictEqual(after.values.routing.retry["request-retry"], 2);
        assert.strictEqual(
          after.values.oauth.providers.antigravity["signature-bypass-strict"],
          true,
        );
        assert.deepStrictEqual(after.revisions, saved.revisions);
      }).pipe(through(harness)),
    );

    it.effect("refusals carry message and path in ManagementError", () =>
      Effect.gen(function* () {
        const api = yield* client;
        const view = yield* api.settings.get();

        const invalid = yield* Effect.flip(
          api.settings.save({
            payload: {
              revisions: view.revisions,
              patch: { routing: { "session-affinity-ttl": "x" } },
            },
          }),
        );

        assert.instanceOf(invalid, ManagementError);
        assert.strictEqual(invalid.error, "invalid_setting");
        assert.strictEqual(invalid.path, "routing.session-affinity-ttl");
        assert.isString(invalid.message);

        yield* api.settings.save({
          payload: { revisions: view.revisions, patch: { routing: { "session-affinity": true } } },
        });

        const stale = yield* Effect.flip(
          api.settings.save({
            payload: {
              revisions: view.revisions,
              patch: { routing: { "session-affinity": false } },
            },
          }),
        );

        assert.instanceOf(stale, ManagementError);
        assert.strictEqual(stale.error, "conflict");
        assert.isTrue((yield* api.settings.get()).values.routing["session-affinity"]);
      }).pipe(through(harness)),
    );

    it.effect("importConfig stores a Go config document and names the keys it did not store", () =>
      Effect.gen(function* () {
        const api = yield* client;

        const imported = yield* api.settings.importConfig({
          payload:
            "routing:\n  strategy: fill-first\naccess:\n  api-keys: [client-key]\n" +
            "claude-api-key:\n  - api-key: sk-ant-contract-secret-4242\n",
        });

        assert.deepStrictEqual(imported.not_applied, ["access.api-keys"]);
        const view = yield* api.settings.get();

        assert.strictEqual(view.version, imported.version);
        assert.strictEqual(view.values.routing.strategy, "fill-first");
        assert.strictEqual((yield* api.providerKeys.list()).families.claude.length, 1);

        const syntax = yield* Effect.flip(
          api.settings.importConfig({ payload: "routing:\n  strategy: [a\n" }),
        );

        assert.instanceOf(syntax, ManagementError);
        assert.strictEqual(syntax.error, "invalid_config");
        assert.isNumber(syntax.line);

        const invalid = yield* Effect.flip(
          api.settings.importConfig({ payload: "routing:\n  retry:\n    request-retry: lots\n" }),
        );

        assert.instanceOf(invalid, ManagementError);
        assert.strictEqual(invalid.error, "invalid_config");
        // Nothing was stored by the refused imports.
        assert.strictEqual((yield* api.settings.get()).version, imported.version);
      }).pipe(through(harness)),
    );

    it("has no endpoint that writes the whole configuration but the import", () => {
      const writes = Object.values(ManagementApi.groups).flatMap((group) =>
        Object.values(group.endpoints)
          .filter((endpoint) => endpoint.method !== "GET")
          .map((endpoint) => endpoint.path),
      );

      assert.deepStrictEqual(
        writes.filter((path) => /^\/(config|settings\/config)($|[./])/.test(path)),
        [],
      );
    });

    it("has no endpoint for the token-disclosing routes (api-call, credential download)", () => {
      const paths = Object.values(ManagementApi.groups).flatMap((group) =>
        Object.values(group.endpoints).map((endpoint) => endpoint.path),
      );

      assert.isNotEmpty(paths);
      assert.deepStrictEqual(
        paths.filter((path) => /^\/(requests\/api-call|credentials\/download)/.test(path)),
        [],
      );
    });

    it("no panel endpoint reads the configuration through GET /config*", () => {
      const reads = Object.values(ManagementApi.groups).flatMap((group) =>
        Object.values(group.endpoints)
          .filter((endpoint) => endpoint.method === "GET")
          .map((endpoint) => endpoint.path),
      );

      assert.isNotEmpty(reads);
      assert.deepStrictEqual(
        reads.filter((path) => /^\/config($|[./])/.test(path)),
        [],
      );
    });
  });
});
