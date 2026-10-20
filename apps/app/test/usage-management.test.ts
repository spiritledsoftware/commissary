// /v9/management/observability/usage/*: queue, records and summary (D1).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, resetControlPlane, token } from "./support/management.ts";
import { insertUsageRecord, resetUsageDb, sampleRecord } from "@commissary/models/testing";

const harness = makeHarness();

afterAll(harness.dispose);

const { json } = harness;

const BASE = "/v9/management/observability/usage";

let db: D1Database;

beforeEach(async () => {
  db = await resetUsageDb();
  await resetControlPlane();
});

const seed = async () => {
  await insertUsageRecord(
    db,
    sampleRecord({ requestId: "r1", requestedAt: 1_700_000_000_000, model: "gpt-5" }),
  );
  await insertUsageRecord(
    db,
    sampleRecord({
      requestId: "r2",
      requestedAt: 1_700_000_001_000,
      model: "gpt-5",
      principalId: "user:b",
    }),
  );
  await insertUsageRecord(
    db,
    sampleRecord({
      requestId: "r3",
      requestedAt: 1_700_000_002_000,
      model: "gpt-4",
      failed: true,
      fail: { statusCode: 502, type: "bad_gateway" },
    }),
  );
};

describe("access", () => {
  it("requires an admin principal", async () => {
    expect((await harness.call(`${BASE}/queue`, { auth: false })).status).toBe(401);
    expect(
      (await harness.call(`${BASE}/queue`, { auth: await token("someone@example.com") })).status,
    ).toBe(403);
  });
});

describe("GET /queue", () => {
  it("pops one record by default, then the requested count, oldest first", async () => {
    await seed();
    const first = await json(`${BASE}/queue`);
    expect(first.status).toBe(200);
    expect((first.body as Array<{ request_id: string }>).map((item) => item.request_id)).toEqual([
      "r1",
    ]);
    const rest = await json(`${BASE}/queue?count=5`);
    expect((rest.body as Array<{ request_id: string }>).map((item) => item.request_id)).toEqual([
      "r2",
      "r3",
    ]);
    expect((await json(`${BASE}/queue`)).body).toEqual([]);
  });

  it("rejects an invalid count", async () => {
    for (const count of ["0", "-1", "abc", "1.5"]) {
      const response = await json(`${BASE}/queue?count=${count}`);
      expect(response).toMatchObject({
        status: 400,
        body: { error: "count must be a positive integer" },
      });
    }
  });

  it("answers 503 without the D1 binding", async () => {
    const detached = makeHarness(undefined, { USAGE: undefined } as unknown as Partial<Env>);

    try {
      expect(await detached.json(`${BASE}/queue`)).toMatchObject({
        status: 503,
        body: { error: "usage store unavailable" },
      });
    } finally {
      await detached.dispose();
    }
  });
});

describe("GET /records and /summary", () => {
  it("lists with filters and a continuation cursor", async () => {
    await seed();
    const page = await json(`${BASE}/records?limit=2`);
    const body = page.body as { records: Array<{ request_id: string }>; next_before: string };
    expect(body.records.map((item) => item.request_id)).toEqual(["r3", "r2"]);

    const next = await json(
      `${BASE}/records?limit=2&before=${encodeURIComponent(body.next_before)}`,
    );

    expect(
      (next.body as { records: Array<{ request_id: string }> }).records.map(
        (item) => item.request_id,
      ),
    ).toEqual(["r1"]);
    expect((next.body as { next_before?: string }).next_before).toBeUndefined();
    const failed = await json(`${BASE}/records?failed=true`);
    expect((failed.body as { records: Array<{ fail: unknown }> }).records).toMatchObject([
      { fail: { status_code: 502, type: "bad_gateway" } },
    ]);

    const since = await json(
      `${BASE}/records?since=${new Date(1_700_000_001_000).toISOString()}&model=gpt-5`,
    );

    expect(
      (since.body as { records: Array<{ request_id: string }> }).records.map(
        (item) => item.request_id,
      ),
    ).toEqual(["r2"]);
  });

  it("validates the query", async () => {
    expect((await json(`${BASE}/records?since=yesterday-ish`)).status).toBe(400);
    expect((await json(`${BASE}/records?failed=maybe`)).status).toBe(400);
    expect((await json(`${BASE}/records?limit=0`)).status).toBe(400);
    expect((await json(`${BASE}/summary?group_by=secret`)).body).toMatchObject({
      error: expect.stringContaining("group_by must be one of"),
    });
  });

  it("summarises token buckets per group", async () => {
    await seed();
    const response = await json(`${BASE}/summary?group_by=principal`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      group_by: "principal",
      totals: { requests: 3, failed: 1, input_tokens: 300, total_tokens: 390 },
      groups: [
        { key: "user:dev@example.com", requests: 2, total_tokens: 260 },
        { key: "user:b", requests: 1, total_tokens: 130 },
      ],
    });
    const byModel = await json(`${BASE}/summary`);
    expect((byModel.body as { group_by: string }).group_by).toBe("model");
  });
});

describe("tool calls (#199)", () => {
  /** A tool call's record of the `global` org, as Tools writes it (`packages/tools/src/usage/record.ts`). */
  const seedToolCall = async () => {
    await db
      .prepare(
        `INSERT INTO usage_records (request_id, requested_at, latency_ms, provider, executor_type, model, alias,
           endpoint, principal_id, org_id, private, auth_id, auth_type, source, failed, cost_micros, unpriced, area,
           toolkit_id, tool_id, tool_outcome, request_bytes, response_bytes)
         VALUES ('t1', 1700000003000, 9, '', '', '', '', 'POST /mcp', 'user:a', 'global', 0, '', 'shared', '', 1,
           0, 0, 'tools', 'tk_a', 'tk_a:search', 'tool_error', 10, 20)`,
      )
      .run();
  };

  type Records = { readonly records: ReadonlyArray<Record<string, unknown>> };

  const requestIds = async (query: string) =>
    // SAFETY: the records route answers `{records}`.
    ((await json(`${BASE}/records${query}`)).body as Records).records.map(
      (record) => record["request_id"],
    );

  it("are read only when asked for, by area, toolkit or tool, and never exported", async () => {
    await seed();
    await seedToolCall();

    expect(await requestIds("")).toEqual(["r3", "r2", "r1"]);
    expect(await requestIds("?area=all")).toEqual(["t1", "r3", "r2", "r1"]);
    expect(await requestIds("?toolkit=tk_a")).toEqual(["t1"]);
    expect(await requestIds("?tool=tk_a:other")).toEqual([]);

    const tools = await json(`${BASE}/records?area=tools`);

    // SAFETY: the records route answers `{records}`.
    expect((tools.body as Records).records).toEqual([
      expect.objectContaining({
        area: "tools",
        toolkit_id: "tk_a",
        tool_id: "tk_a:search",
        outcome: "tool_error",
        credential: "shared",
        request_bytes: 10,
        response_bytes: 20,
        failed: true,
        fail: { status_code: 200 },
        cost_micros: 0,
      }),
    ]);

    const summary = await json(`${BASE}/summary?group_by=toolkit&area=tools`);

    expect(summary.body).toMatchObject({
      group_by: "toolkit",
      totals: { requests: 1, failed: 1 },
      groups: [{ key: "tk_a", requests: 1 }],
    });
    expect((await json(`${BASE}/records?area=nope`)).status).toBe(400);

    // SAFETY: the queue answers an array of records.
    const queue = (await json(`${BASE}/queue?count=10`)).body as ReadonlyArray<
      Record<string, unknown>
    >;

    expect(queue.map((record) => record["request_id"])).toEqual(["r1", "r2", "r3"]);
  });
});
