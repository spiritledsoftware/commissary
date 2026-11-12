// The cost of a usage record, from the write to the totals (ADR 0024): the D1 sink prices each record with the
// catalog's models.dev prices or the org's price override from its real ControlPlane, stores the cost, and never
// recomputes it when a price changes later.
import { env } from "cloudflare:workers";
import { Duration, Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ConfigReader } from "../src/config/reader.ts";
import type { PriceOverrideValue } from "../src/config/store.ts";
import { WorkerExecutionContext, GLOBAL_ORG, OrgId } from "@commissary/core";
import { CatalogStore } from "../src/registry/catalog-store.ts";
import {
  insertUsageRecord,
  listUsageRecords,
  summarizeUsage,
  unpricedModels,
} from "../src/usage/d1.ts";
import { D1UsageSink } from "../src/usage/d1-sink.ts";
import { UsagePricing } from "../src/usage/pricing-service.ts";
import type { UsageRecord } from "../src/usage/record.ts";
import { parseClaudeUsage, parseGeminiUsage } from "../src/usage/parsers.ts";
import { UsageSink } from "../src/usage/sink.ts";
import { authIndexOf } from "./support/auth-index.ts";
import { controlPlane, resetControlPlane, resetOrgControlPlane } from "./support/control-plane.ts";
import { resetUsageDb, sampleRecord } from "./support/usage.ts";
import { envContext } from "./support/context.ts";

let db: D1Database;

beforeEach(async () => {
  db = await resetUsageDb();
  await resetControlPlane();
});

/** The sink with real pricing: the org's overrides come from its ControlPlane (read afresh each time), the catalog from KV. */
const sink = D1UsageSink.pipe(
  Layer.provide(UsagePricing.layer),
  Layer.provide(CatalogStore.layer),
  Layer.provide(ConfigReader.layerControlPlane({ ttl: Duration.zero })),
);

/** Publishes `record` through the sink and waits for its detached write. */
const publish = async (record: UsageRecord): Promise<void> => {
  const pending: Array<Promise<unknown>> = [];

  // SAFETY: the sink only calls waitUntil.
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
  } as unknown as ExecutionContext;

  await Effect.gen(function* () {
    yield* (yield* UsageSink).publish(record);
  }).pipe(
    Effect.provide(sink),
    Effect.provideContext(envContext(env)),
    Effect.provideService(WorkerExecutionContext, ctx),
    Effect.runPromise,
  );
  await Promise.all(pending);
};

const stored = async (requestId: string) => {
  const { rows } = await listUsageRecords(db, GLOBAL_ORG, {}, authIndexOf);
  const row = rows.find((candidate) => candidate.request_id === requestId);

  if (row === undefined) throw new Error(`no record ${requestId}`);

  return { cost_micros: row.cost_micros, unpriced: row.unpriced };
};

const override = async (value: PriceOverrideValue, org = GLOBAL_ORG) => {
  const result = await controlPlane(org)
    .models()
    .writePriceOverride({ revision: 0, value }, "test");

  if (!result.ok) throw new Error(result.message);

  return result;
};

describe("the cost of a record at write time", () => {
  it("prices a codex attempt at the catalog's gpt-5 price with cache reads and reasoning", async () => {
    // 60 uncached x $1.25 + 40 cached x $0.125 + 30 output (12 reasoning, billed as output) x $10 per million.
    await publish(sampleRecord({ requestId: "gpt" }));

    expect(await stored("gpt")).toEqual({ cost_micros: 380, unpriced: 0 });
  });

  it("prices a Claude attempt with cache writes, cache reads and thinking tokens", async () => {
    const detail = parseClaudeUsage(
      '{"usage":{"input_tokens":2,"cache_creation_input_tokens":831,"cache_read_input_tokens":44225,"output_tokens":244,"output_tokens_details":{"thinking_tokens":40}}}',
    );

    await publish(
      sampleRecord({
        requestId: "claude",
        provider: "claude",
        executorType: "claude",
        model: "claude-sonnet-4-5",
        detail,
      }),
    );

    // 2 x 3 + 831 x 3.75 + 44225 x 0.3 + 244 x 15 = 20049.75 micro-dollars, rounded once.
    expect(await stored("claude")).toEqual({ cost_micros: 20_050, unpriced: 0 });
  });

  it("prices a Gemini attempt, adding its separate thoughts to the output", async () => {
    const detail = parseGeminiUsage(
      '{"usageMetadata":{"promptTokenCount":1000,"cachedContentTokenCount":400,"candidatesTokenCount":200,"thoughtsTokenCount":50,"totalTokenCount":1250}}',
    );

    await publish(
      sampleRecord({
        requestId: "gemini",
        provider: "gemini",
        executorType: "gemini",
        model: "gemini-2.5-flash",
        detail,
      }),
    );

    // 600 x 0.3 + 400 x 0.03 + (200 + 50) x 2.5 = 180 + 12 + 625 micro-dollars.
    expect(await stored("gemini")).toEqual({ cost_micros: 817, unpriced: 0 });
  });

  it("costs a subscription attempt like an API one: the account type does not matter", async () => {
    await publish(sampleRecord({ requestId: "oauth", authType: "oauth" }));
    await publish(sampleRecord({ requestId: "key", authType: "api_key" }));

    expect(await stored("oauth")).toEqual(await stored("key"));
  });

  it("lets an override win over the catalog price, case-insensitively", async () => {
    await override({ provider: "Codex", model: "GPT-5", input: 2, output: 20, cache_read: 1 });
    await publish(sampleRecord({ requestId: "over" }));

    // 60 x 2 + 40 x 1 + 30 x 20 = 760 (the catalog's price would give 380).
    expect(await stored("over")).toEqual({ cost_micros: 760, unpriced: 0 });
  });

  it("prices a model only an override knows, charging cache tokens at the input price", async () => {
    await override({ provider: "codex", model: "house-model", input: 4, output: 8 });
    await publish(sampleRecord({ requestId: "house", model: "house-model" }));

    // (60 + 40) x 4 + 30 x 8 = 640.
    expect(await stored("house")).toEqual({ cost_micros: 640, unpriced: 0 });
  });

  it("stores no cost for an unpriced model: zero, flagged, and listed to price", async () => {
    await publish(sampleRecord({ requestId: "mystery", model: "mystery-1" }));

    expect(await stored("mystery")).toEqual({ cost_micros: 0, unpriced: 1 });

    const summary = await summarizeUsage(db, GLOBAL_ORG, { groupBy: "model" }, authIndexOf);
    expect(summary.totals).toMatchObject({ cost_micros: 0, unpriced_requests: 1 });

    expect(await unpricedModels(db, GLOBAL_ORG, {}, authIndexOf)).toEqual([
      { provider: "codex", model: "mystery-1", requests: 1, total_tokens: 130 },
    ]);
  });

  it("does not flag a request that used no tokens, priced or not", async () => {
    const empty = { ...sampleRecord().detail, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };

    await publish(
      sampleRecord({
        requestId: "refused",
        model: "mystery-1",
        failed: true,
        fail: { statusCode: 401 },
        detail: { ...empty, cachedTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
      }),
    );

    expect(await stored("refused")).toEqual({ cost_micros: 0, unpriced: 0 });
  });

  it("stops listing a model once an override prices it, for the traffic after it only", async () => {
    await publish(sampleRecord({ requestId: "before", model: "mystery-1" }));
    await override({ provider: "codex", model: "mystery-1", input: 1, output: 1 });
    await publish(sampleRecord({ requestId: "after", model: "mystery-1" }));

    expect(await stored("before")).toEqual({ cost_micros: 0, unpriced: 1 });
    expect(await stored("after")).toEqual({ cost_micros: 130, unpriced: 0 });
  });

  it("keeps the stored cost when an override changes or is removed later", async () => {
    const first = await override({ provider: "codex", model: "gpt-5", input: 2, output: 20 });
    await publish(sampleRecord({ requestId: "old" }));

    const old = await stored("old");

    expect(old).toEqual({ cost_micros: 100 * 2 + 30 * 20, unpriced: 0 });

    const changed = await controlPlane()
      .models()
      .writePriceOverride(
        {
          id: first.id,
          revision: first.revision,
          value: { provider: "codex", model: "gpt-5", input: 100, output: 100 },
        },
        "test",
      );

    expect(changed.ok).toBe(true);
    await publish(sampleRecord({ requestId: "new" }));

    expect(await stored("old")).toEqual(old);
    expect(await stored("new")).toEqual({ cost_micros: 100 * 100 + 30 * 100, unpriced: 0 });

    if (changed.ok)
      await controlPlane()
        .models()
        .writePriceOverride({ id: first.id, revision: changed.revision, value: null }, "test");
    await publish(sampleRecord({ requestId: "catalog" }));

    expect(await stored("old")).toEqual(old);
    expect(await stored("new")).toEqual({ cost_micros: 13_000, unpriced: 0 });
    expect(await stored("catalog")).toEqual({ cost_micros: 380, unpriced: 0 });
  });

  it("uses the overrides of the record's own org", async () => {
    const other = OrgId.make(`cost-${crypto.randomUUID().slice(0, 8)}`);
    await override({ provider: "codex", model: "gpt-5", input: 50, output: 50 }, other);

    await publish(sampleRecord({ requestId: "global" }));
    await publish(sampleRecord({ requestId: "other", orgId: other }));

    expect(await stored("global")).toEqual({ cost_micros: 380, unpriced: 0 });

    const { rows } = await listUsageRecords(db, other, {}, authIndexOf);

    expect(rows.map((row) => row.cost_micros)).toEqual([50 * 130]);
    await resetOrgControlPlane(other);
  });

  it("still stores the record, without a cost, when it cannot be priced", async () => {
    const failing = Layer.succeed(
      UsagePricing,
      UsagePricing.of({ costOf: () => Effect.die(new Error("boom")) }),
    );

    const pending: Array<Promise<unknown>> = [];

    // SAFETY: the sink only calls waitUntil.
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    } as unknown as ExecutionContext;

    await Effect.gen(function* () {
      yield* (yield* UsageSink).publish(sampleRecord({ requestId: "kept" }));
    }).pipe(
      Effect.provide(D1UsageSink.pipe(Layer.provide(failing))),
      Effect.provideContext(envContext(env)),
      Effect.provideService(WorkerExecutionContext, ctx),
      Effect.runPromise,
    );
    await Promise.all(pending);

    expect(await stored("kept")).toEqual({ cost_micros: null, unpriced: 0 });
  });

  it("totals the cost of an org's records in summaries and groups them", async () => {
    await publish(sampleRecord({ requestId: "a" }));
    await publish(sampleRecord({ requestId: "b", model: "gpt-5-mini" }));
    await publish(sampleRecord({ requestId: "c", model: "mystery-1" }));

    const summary = await summarizeUsage(db, GLOBAL_ORG, { groupBy: "model" }, authIndexOf);
    const costs = Object.fromEntries(summary.groups.map((group) => [group.key, group.cost_micros]));

    expect(costs["gpt-5"]).toBe(380);
    expect(costs["mystery-1"]).toBe(0);
    expect(costs["gpt-5-mini"]).toBeGreaterThan(0);
    expect(summary.totals.cost_micros).toBe(380 + (costs["gpt-5-mini"] ?? 0));
    expect(summary.totals.unpriced_requests).toBe(1);
  });
});

describe("costing for a Spend limit (issue #71)", () => {
  const costOf = async (record: UsageRecord) =>
    await Effect.gen(function* () {
      return yield* (yield* UsageSink).cost(record);
    }).pipe(Effect.provide(sink), Effect.provideContext(envContext(env)), Effect.runPromise);

  it("prices a record with the prices that are stored, and writes none", async () => {
    expect(await costOf(sampleRecord({ requestId: "spend-a" }))).toEqual({
      micros: 380,
      unpriced: false,
    });

    expect(await costOf(sampleRecord({ requestId: "spend-b", model: "mystery-1" }))).toEqual({
      micros: 0,
      unpriced: true,
    });
  });

  it("stores a record that was costed for a limit with that cost, not a second pricing", async () => {
    await publish(sampleRecord({ requestId: "spend-c", cost: { micros: 7, unpriced: false } }));

    expect(await stored("spend-c")).toEqual({ cost_micros: 7, unpriced: 0 });
  });

  it("answers no cost when pricing fails, which charges nothing", async () => {
    const failing = Layer.succeed(
      UsagePricing,
      UsagePricing.of({ costOf: () => Effect.die(new Error("catalog down")) }),
    );

    const cost = await Effect.gen(function* () {
      return yield* (yield* UsageSink).cost(sampleRecord({ requestId: "spend-d" }));
    }).pipe(
      Effect.provide(D1UsageSink.pipe(Layer.provide(failing))),
      Effect.provideContext(envContext(env)),
      Effect.runPromise,
    );

    expect(cost).toBeUndefined();
  });
});

describe("records written directly", () => {
  it("keeps the cost a record carries", async () => {
    await insertUsageRecord(
      db,
      sampleRecord({ requestId: "x", cost: { micros: 7, unpriced: false } }),
    );

    expect(await stored("x")).toEqual({ cost_micros: 7, unpriced: 0 });
  });
});
