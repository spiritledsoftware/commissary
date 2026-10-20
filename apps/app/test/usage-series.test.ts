// GET /v9/management/observability/usage/series: requests, failures and tokens per key × UTC hour/day bucket (D1).
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { afterAll, beforeEach, expect, it as plain } from "vitest";
import { ManagementApi } from "@commissary/contract/api";
import { ManagementError } from "@commissary/contract/errors";
import { type Harness, makeHarness, resetControlPlane } from "./support/management.ts";
import {
  authIndexOf,
  insertUsageRecord,
  resetUsageDb,
  sampleRecord,
} from "@commissary/models/testing";

const harness = makeHarness();

const withoutUsage = makeHarness(undefined, { USAGE: undefined } as unknown as Partial<Env>);

afterAll(async () => {
  await harness.dispose();
  await withoutUsage.dispose();
});

const BASE = "/v9/management/observability/usage/series";

const HOUR = 3_600_000;

const DAY = 86_400_000;

/** A UTC midnight, so hour and day boundaries are easy to write down. */
const D0 = Date.UTC(2026, 0, 5);

let db: D1Database;

beforeEach(async () => {
  db = await resetUsageDb();
  await resetControlPlane();
});

const add = (requestedAt: number, overrides: Parameters<typeof sampleRecord>[0] = {}) =>
  insertUsageRecord(db, sampleRecord({ requestedAt, ...overrides }));

/** Tokens of one default sample record (v2 `acct_total_tokens`). */
const tokensOfSample = async (): Promise<number> => {
  await resetUsageDb(db);
  await add(D0);

  const row = await db.prepare("SELECT acct_total_tokens AS t FROM usage_records").first<{
    t: number;
  }>();

  await resetUsageDb(db);

  return row?.t ?? -1;
};

interface SeriesBody {
  readonly bucket: string;
  readonly group_by: string;
  readonly series: ReadonlyArray<{
    readonly key: string;
    readonly points: ReadonlyArray<{ readonly start: number; readonly requests: number }>;
  }>;
}

const get = async (query: string) => {
  const response = await harness.json(`${BASE}?${query}`);

  // SAFETY: only read after a 200 (or compared whole against an expected literal); error bodies are matched by toMatchObject.
  return { status: response.status, body: response.body as SeriesBody };
};

describe("bucketing", () => {
  plain("splits at hour boundaries and sums within a bucket", async () => {
    const tokens = await tokensOfSample();
    assert.isAbove(tokens, 0);
    await add(D0 + HOUR - 1);
    await add(D0 + HOUR); // next hour (boundary is inclusive)
    await add(D0 + HOUR + 5, { failed: true });
    await add(D0 + 5 * HOUR);

    const { status, body } = await get(`since=${D0}&until=${D0 + DAY}`);

    expect(status).toBe(200);
    expect(body).toEqual({
      bucket: "hour",
      group_by: "auth",
      series: [
        {
          key: authIndexOf("codex-a.json"),
          points: [
            { start: D0, requests: 1, failed: 0, total_tokens: tokens, cost_micros: 0 },
            { start: D0 + HOUR, requests: 2, failed: 1, total_tokens: 2 * tokens, cost_micros: 0 },
            { start: D0 + 5 * HOUR, requests: 1, failed: 0, total_tokens: tokens, cost_micros: 0 },
          ],
        },
      ],
    });
  });

  plain("splits at UTC day boundaries", async () => {
    const tokens = await tokensOfSample();
    await add(D0 - 1); // previous day
    await add(D0 + 3 * HOUR);
    await add(D0 + DAY - 1);
    await add(D0 + DAY);

    const { body } = await get(`since=${D0 - DAY}&until=${D0 + 2 * DAY}&bucket=day`);

    expect(body).toEqual({
      bucket: "day",
      group_by: "auth",
      series: [
        {
          key: authIndexOf("codex-a.json"),
          points: [
            { start: D0 - DAY, requests: 1, failed: 0, total_tokens: tokens, cost_micros: 0 },
            { start: D0, requests: 2, failed: 0, total_tokens: 2 * tokens, cost_micros: 0 },
            { start: D0 + DAY, requests: 1, failed: 0, total_tokens: tokens, cost_micros: 0 },
          ],
        },
      ],
    });
  });

  plain("since is inclusive and until exclusive", async () => {
    await add(D0 - 1);
    await add(D0);
    await add(D0 + HOUR);

    const { body } = await get(`since=${D0}&until=${D0 + HOUR}`);

    expect(body).toMatchObject({ series: [{ points: [{ start: D0, requests: 1 }] }] });
  });

  plain("accepts ISO times and keeps series sorted by key", async () => {
    await add(D0, { authId: "b.json" });
    await add(D0, { authId: "a.json" });

    const { body } = await get(`since=${new Date(D0).toISOString()}&until=${D0 + HOUR}`);

    // Keyed by auth_index (never the credential id), sorted by that key.
    expect(body.series.map((s) => s.key)).toEqual(
      [authIndexOf("a.json"), authIndexOf("b.json")].toSorted(),
    );
  });

  plain("answers an empty series when nothing matches", async () => {
    expect((await get(`since=${D0}&until=${D0 + HOUR}`)).body).toEqual({
      bucket: "hour",
      group_by: "auth",
      series: [],
    });
  });
});

describe("grouping and filters", () => {
  const seed = async () => {
    await add(D0, { authId: "a.json", model: "gpt-5", provider: "codex" });
    await add(D0 + 1, { authId: "a.json", model: "gpt-4", provider: "codex" });
    await add(D0 + 2, { authId: "b.json", model: "gpt-5", provider: "claude" });
  };

  const summary = (body: SeriesBody) =>
    body.series.map((s) => [s.key, s.points.map((p) => p.requests)]);

  const a = authIndexOf("a.json");
  const b = authIndexOf("b.json");

  const byIndex = (rows: Array<[string, number[]]>) =>
    rows.toSorted(([x], [y]) => (x < y ? -1 : 1));

  plain("groups by auth, model and provider", async () => {
    await seed();
    const range = `since=${D0}&until=${D0 + HOUR}`;

    expect(summary((await get(`${range}&group_by=auth`)).body)).toEqual(
      byIndex([
        [a, [2]],
        [b, [1]],
      ]),
    );
    expect(summary((await get(`${range}&group_by=model`)).body)).toEqual([
      ["gpt-4", [1]],
      ["gpt-5", [2]],
    ]);
    expect(summary((await get(`${range}&group_by=provider`)).body)).toEqual([
      ["claude", [1]],
      ["codex", [2]],
    ]);
  });

  plain("filters by provider (case-insensitive), model and auth_index", async () => {
    await seed();
    const range = `since=${D0}&until=${D0 + HOUR}`;

    expect(summary((await get(`${range}&provider=CODEX`)).body)).toEqual([[a, [2]]]);
    expect(summary((await get(`${range}&model=gpt-5`)).body)).toEqual(
      byIndex([
        [a, [1]],
        [b, [1]],
      ]),
    );
    expect(summary((await get(`${range}&auth_index=${b}`)).body)).toEqual([[b, [1]]]);
    expect(summary((await get(`${range}&auth_index=${b.toUpperCase()}`)).body)).toEqual([[b, [1]]]);
    expect(summary((await get(`${range}&auth_index=${b}&model=gpt-4`)).body)).toEqual([]);
    expect(summary((await get(`${range}&auth_index=0000000000000000`)).body)).toEqual([]);
    // The stored credential id is not a filter any more: refused rather than silently ignored.
    expect((await get(`${range}&auth_id=b.json`)).status).toBe(400);
  });
});

describe("defaults", () => {
  plain("until defaults to now, bucket to hour and group_by to auth", async () => {
    const now = Date.now();
    await add(now - 2 * HOUR);
    await add(now + 10 * DAY); // in the future: excluded by the default until

    const { status, body } = await get(`since=${now - DAY}`);

    expect(status).toBe(200);
    const parsed = body;

    expect(parsed.bucket).toBe("hour");
    expect(parsed.group_by).toBe("auth");
    expect(parsed.series).toHaveLength(1);
    expect(parsed.series[0]?.points).toHaveLength(1);
    expect(parsed.series[0]?.points[0]?.start).toBe(Math.floor((now - 2 * HOUR) / HOUR) * HOUR);
  });

  plain("ignores summary-only params", async () => {
    await add(D0);

    expect((await get(`since=${D0}&until=${D0 + HOUR}&failed=maybe&principal=x`)).status).toBe(200);
  });
});

describe("400s", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["", "since is required"],
    ["since=", "since is required"],
    ["since=abc", "since must be epoch milliseconds or an ISO 8601 time"],
    [`since=${D0}&until=zzz`, "until must be epoch milliseconds or an ISO 8601 time"],
    [`since=${D0}&until=${D0}`, "until must be after since"],
    [`since=${D0}&until=${D0 - 1}`, "until must be after since"],
    [`since=${D0}&bucket=week`, "bucket must be one of hour, day"],
    [
      `since=${D0}&group_by=principal`,
      "group_by must be one of auth, model, provider, toolkit, tool",
    ],
    [`since=${D0}&until=${D0 + 31 * DAY + 1}`, "range must not exceed 31 days for bucket=hour"],
    [
      `since=${D0}&until=${D0 + 400 * DAY + 1}&bucket=day`,
      "range must not exceed 400 days for bucket=day",
    ],
  ];

  for (const [query, message] of cases) {
    plain(`${query || "(no params)"} -> ${message}`, async () => {
      expect(await get(query)).toMatchObject({ status: 400, body: { error: message } });
    });
  }

  plain("accepts the maximum ranges", async () => {
    expect((await get(`since=${D0}&until=${D0 + 31 * DAY}`)).status).toBe(200);
    expect((await get(`since=${D0}&until=${D0 + 400 * DAY}&bucket=day`)).status).toBe(200);
  });

  plain("answers 503 without the D1 binding", async () => {
    expect(await withoutUsage.json(`${BASE}?since=${D0}&until=${D0 + HOUR}`)).toMatchObject({
      status: 503,
      body: { error: "usage store unavailable" },
    });
  });
});

// --- contract ------------------------------------------------------------------------------------------------------

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

const client = HttpApiClient.make(ManagementApi, { baseUrl: "https://commissary.test" });

const through = (target: Harness) =>
  Effect.provide(
    Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetchVia(target))),
  );

describe("contract", () => {
  it.effect("decodes a series and its defaults", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await add(D0);
        await add(D0 + HOUR, { failed: true });
      });

      const api = yield* client;
      const series = yield* api.usage.series({ query: { since: D0, until: D0 + DAY } });

      assert.strictEqual(series.bucket, "hour");
      assert.strictEqual(series.group_by, "auth");
      assert.deepStrictEqual(
        series.series.map((entry) => [entry.key, entry.points.map((p) => [p.start, p.failed])]),
        [
          [
            authIndexOf("codex-a.json"),
            [
              [D0, 0],
              [D0 + HOUR, 1],
            ],
          ],
        ],
      );

      const byModel = yield* api.usage.series({
        query: { since: D0, until: D0 + DAY, bucket: "day", group_by: "model", model: "gpt-5" },
      });

      assert.strictEqual(byModel.bucket, "day");
      assert.deepStrictEqual(
        byModel.series.map((entry) => [entry.key, entry.points.map((p) => p.requests)]),
        [["gpt-5", [2]]],
      );
    }).pipe(through(harness)),
  );

  it.effect("decodes error bodies into ManagementError", () =>
    Effect.gen(function* () {
      const api = yield* client;

      const error = yield* Effect.flip(
        api.usage.series({ query: { since: D0, until: D0 + HOUR } }),
      );

      assert.instanceOf(error, ManagementError);
      assert.strictEqual(error.error, "usage store unavailable");
    }).pipe(through(withoutUsage)),
  );
});
