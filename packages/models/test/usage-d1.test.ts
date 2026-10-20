// D1 persistence of usage records: schema, sink (ctx.waitUntil), export queue, listing, summary and retention.
import { env } from "cloudflare:workers";
import { Effect, Layer, Logger, References } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkerExecutionContext, GLOBAL_ORG, OrgId } from "@commissary/core";
import { scheduledTasks } from "../src/scheduled-tasks.ts";
import {
  deleteOrgUsage,
  insertUsageRecord,
  listUsageRecords,
  popUsageQueue,
  pruneUsageRecords,
  recordToRow,
  resolveAuthIds,
  rowToPayload,
  summarizeUsage,
  summarizeUsageSeries,
  type UsageRow,
  unpricedModels,
} from "../src/usage/d1.ts";
import { D1UsageSink } from "../src/usage/d1-sink.ts";
import { UsagePricing } from "../src/usage/pricing-service.ts";
import { ensureTokenBreakdown } from "../src/usage/accounting.ts";
import { parseClaudeUsage } from "../src/usage/parsers.ts";
import { pruneExpiredUsage } from "../src/usage/retention.ts";
import { UsageSink } from "../src/usage/sink.ts";
import { authIndexOf } from "./support/auth-index.ts";
import { resetUsageDb, sampleRecord, statementsOf } from "./support/usage.ts";
import initialMigration from "../../../migrations/usage/0001_usage_records.sql?raw";
import sessionsMigration from "../../../migrations/usage/0002_usage_sessions.sql?raw";
import orgMigration from "../../../migrations/usage/0003_usage_org.sql?raw";
import costMigration from "../../../migrations/usage/0004_usage_cost.sql?raw";
import memberMigration from "../../../migrations/usage/0005_usage_member.sql?raw";
import privateMigration from "../../../migrations/usage/0006_usage_private.sql?raw";
import failureMigration from "../../../migrations/usage/0007_usage_failure.sql?raw";
import hostedAuthMigration from "../../../migrations/usage/0008_hosted_auth.sql?raw";
import dropHostedAuthMigration from "../../../migrations/usage/0009_drop_hosted_auth.sql?raw";
import toolCallsMigration from "../../../migrations/usage/0010_usage_tool_calls.sql?raw";
import { platformOf } from "@commissary/state";
import { envContext } from "./support/context.ts";

/** The D1 sink without pricing: records are stored as they are published. */
const sink = D1UsageSink.pipe(Layer.provide(UsagePricing.none));

let db: D1Database;

beforeEach(async () => {
  db = await resetUsageDb();
});

const rows = async () =>
  (
    await db
      .prepare("SELECT * FROM usage_records ORDER BY requested_at, org_id, request_id")
      .all<UsageRow>()
  ).results;

describe("migration 0003 (usage org)", () => {
  it("moves the records written before orgs into global and indexes the org", async () => {
    await db.prepare("DROP TABLE usage_records").run();

    for (const statement of [...statementsOf(initialMigration), ...statementsOf(sessionsMigration)])
      await db.prepare(statement).run();

    // A row as the previous schema stored it.
    await db
      .prepare(
        `INSERT INTO usage_records (request_id, requested_at, provider, executor_type, model, alias, endpoint,
           principal_id, auth_id, auth_type, source) VALUES ('old', 1, 'codex', 'codex', 'gpt-5', 'gpt-5',
           'POST /v1/responses', 'user:a', 'codex-a.json', 'oauth', 'a')`,
      )
      .run();

    for (const statement of statementsOf(orgMigration)) await db.prepare(statement).run();

    const [row] = await rows();
    expect(row).toMatchObject({ request_id: "old", org_id: "global" });

    const indexes = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_records'")
      .all<{ readonly name: string }>();

    expect(indexes.results.map((index) => index.name)).toEqual(
      expect.arrayContaining(["usage_records_org", "usage_records_org_unexported"]),
    );

    // Reads need the whole schema: apply the later migrations as a deploy does.
    for (const statement of [
      ...statementsOf(costMigration),
      ...statementsOf(memberMigration),
      ...statementsOf(privateMigration),
      ...statementsOf(failureMigration),
      ...statementsOf(toolCallsMigration),
    ])
      await db.prepare(statement).run();

    expect((await listUsageRecords(db, GLOBAL_ORG, {}, authIndexOf)).rows).toHaveLength(1);
    expect((await listUsageRecords(db, OrgId.make("acme"), {}, authIndexOf)).rows).toHaveLength(0);

    // Its index statements are idempotent, and new records carry their org.
    for (const statement of statementsOf(orgMigration).filter((sql) => sql.startsWith("CREATE")))
      await db.prepare(statement).run();

    await insertUsageRecord(db, sampleRecord({ requestId: "new", orgId: OrgId.make("acme") }));
    expect((await listUsageRecords(db, OrgId.make("acme"), {}, authIndexOf)).rows).toHaveLength(1);
  });
});

describe("migration 0009 (drop hosted auth)", () => {
  const authObjects = async () =>
    (
      await db
        .prepare(
          "SELECT type, name FROM sqlite_master WHERE name LIKE 'auth\\_%' ESCAPE '\\' ORDER BY name",
        )
        .all<{ readonly type: string; readonly name: string }>()
    ).results;

  it("drops the auth_ tables and their indexes, keeps the usage records", async () => {
    expect(await authObjects()).toEqual([]);

    for (const statement of statementsOf(hostedAuthMigration)) await db.prepare(statement).run();

    await db
      .prepare(
        `INSERT INTO auth_user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES ('u1', 'A', 'a@example.com', 1, 1, 1)`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO auth_session (id, expiresAt, token, createdAt, updatedAt, userId)
         VALUES ('s1', 1, 't', 1, 1, 'u1')`,
      )
      .run();
    await insertUsageRecord(db, sampleRecord({ requestId: "kept" }));

    expect((await authObjects()).map((object) => object.name)).toEqual([
      "auth_account",
      "auth_account_userId_idx",
      "auth_session",
      "auth_session_userId_idx",
      "auth_user",
      "auth_verification",
      "auth_verification_identifier_idx",
    ]);

    for (const statement of statementsOf(dropHostedAuthMigration))
      await db.prepare(statement).run();

    expect(await authObjects()).toEqual([]);
    expect((await rows()).map((row) => row.request_id)).toEqual(["kept"]);

    // A second run is a no-op.
    for (const statement of statementsOf(dropHostedAuthMigration))
      await db.prepare(statement).run();

    expect(await authObjects()).toEqual([]);
  });
});

describe("migration 0007 (usage failure)", () => {
  it("clears the failure bodies stored before it, keeps the rest and adds type and code", async () => {
    await db.prepare("DROP TABLE usage_records").run();

    for (const statement of [
      ...statementsOf(initialMigration),
      ...statementsOf(sessionsMigration),
      ...statementsOf(orgMigration),
      ...statementsOf(costMigration),
      ...statementsOf(memberMigration),
      ...statementsOf(privateMigration),
    ])
      await db.prepare(statement).run();

    // A failed attempt as the previous schema stored it: its body echoes the prompt.
    await db
      .prepare(
        `INSERT INTO usage_records (request_id, requested_at, provider, executor_type, model, alias, endpoint,
           principal_id, auth_id, auth_type, source, org_id, failed, fail_status, fail_body, acct_total_tokens)
         VALUES ('old', 1, 'codex', 'codex', 'gpt-5', 'gpt-5', 'POST /v1/responses', 'user:a', 'codex-a.json',
           'oauth', 'a', 'global', 1, 400, '{"error":{"message":"the prompt said: my secret plan"}}', 500)`,
      )
      .run();

    for (const statement of [
      ...statementsOf(failureMigration),
      ...statementsOf(toolCallsMigration),
    ])
      await db.prepare(statement).run();

    const [row] = await rows();
    expect(row).toMatchObject({
      request_id: "old",
      failed: 1,
      fail_status: 400,
      fail_body: null,
      fail_type: null,
      fail_code: null,
      acct_total_tokens: 500,
    });

    // The record still lists, and exports a failure without a body.
    const listed = await listUsageRecords(db, GLOBAL_ORG, {}, authIndexOf);
    expect(listed.rows).toHaveLength(1);
    expect(rowToPayload(listed.rows[0] as UsageRow, authIndexOf).fail).toEqual({
      status_code: 400,
    });

    // Applying the data statement again changes nothing (the ALTERs are run once, as every migration is).
    await db.prepare("UPDATE usage_records SET fail_body = NULL WHERE fail_body IS NOT NULL").run();
    expect((await rows())[0]).toMatchObject({ fail_body: null });
  });
});

describe("migration 0004 (usage cost)", () => {
  it("leaves the records written before costs without a cost and unflagged, and prices new ones", async () => {
    await db.prepare("DROP TABLE usage_records").run();

    for (const statement of [
      ...statementsOf(initialMigration),
      ...statementsOf(sessionsMigration),
      ...statementsOf(orgMigration),
    ])
      await db.prepare(statement).run();

    await db
      .prepare(
        `INSERT INTO usage_records (request_id, requested_at, provider, executor_type, model, alias, endpoint,
           principal_id, auth_id, auth_type, source, org_id, acct_total_tokens) VALUES ('old', 1, 'codex', 'codex',
           'gpt-5', 'gpt-5', 'POST /v1/responses', 'user:a', 'codex-a.json', 'oauth', 'a', 'global', 500)`,
      )
      .run();

    for (const statement of statementsOf(costMigration)) await db.prepare(statement).run();

    const [row] = await rows();
    expect(row).toMatchObject({ request_id: "old", cost_micros: null, unpriced: 0 });

    for (const statement of [
      ...statementsOf(memberMigration),
      ...statementsOf(privateMigration),
      ...statementsOf(failureMigration),
      ...statementsOf(toolCallsMigration),
    ])
      await db.prepare(statement).run();

    // A new record carries its cost; the old one sums as nothing and is not listed as unpriced.
    await insertUsageRecord(
      db,
      sampleRecord({ requestId: "new", requestedAt: 2, cost: { micros: 1234, unpriced: false } }),
    );
    await insertUsageRecord(
      db,
      sampleRecord({ requestId: "free", requestedAt: 3, cost: { micros: 0, unpriced: true } }),
    );

    const summary = await summarizeUsage(db, GLOBAL_ORG, { groupBy: "model" }, authIndexOf);
    expect(summary.totals).toMatchObject({ requests: 3, cost_micros: 1234, unpriced_requests: 1 });

    const page = await listUsageRecords(db, GLOBAL_ORG, {}, authIndexOf);

    expect(page.rows.map((record) => rowToPayload(record, authIndexOf))).toMatchObject([
      { request_id: "free", cost_micros: 0, unpriced: true },
      { request_id: "new", cost_micros: 1234, unpriced: false },
      { request_id: "old" },
    ]);
    expect(rowToPayload(page.rows[2] as UsageRow, authIndexOf)).not.toHaveProperty("cost_micros");

    // The index of unpriced traffic exists, and the migration's index statement is idempotent.
    const indexes = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_records'")
      .all<{ readonly name: string }>();

    expect(indexes.results.map((index) => index.name)).toContain("usage_records_org_unpriced");

    for (const statement of statementsOf(costMigration).filter((sql) => sql.startsWith("CREATE")))
      await db.prepare(statement).run();
  });

  it("lists the unpriced models of an org by requests, with its own totals per model", async () => {
    const priced = { micros: 10, unpriced: false };
    const free = { micros: 0, unpriced: true };

    await insertUsageRecord(db, sampleRecord({ requestId: "a", model: "gpt-5", cost: priced }));
    await insertUsageRecord(db, sampleRecord({ requestId: "b", model: "mystery", cost: free }));
    await insertUsageRecord(db, sampleRecord({ requestId: "c", model: "mystery", cost: free }));
    await insertUsageRecord(db, sampleRecord({ requestId: "d", model: "other", cost: free }));
    await insertUsageRecord(
      db,
      sampleRecord({ requestId: "e", model: "theirs", cost: free, orgId: OrgId.make("acme") }),
    );

    const models = await unpricedModels(db, GLOBAL_ORG, {}, authIndexOf);

    expect(models.map((entry) => [entry.provider, entry.model, entry.requests])).toEqual([
      ["codex", "mystery", 2],
      ["codex", "other", 1],
    ]);
    expect(await unpricedModels(db, GLOBAL_ORG, { model: "other" }, authIndexOf)).toHaveLength(1);
  });
});

describe("migration 0005 (usage member)", () => {
  it("leaves the records written before members without a member, and filters new ones by member", async () => {
    await db.prepare("DROP TABLE usage_records").run();

    for (const statement of [
      ...statementsOf(initialMigration),
      ...statementsOf(sessionsMigration),
      ...statementsOf(orgMigration),
      ...statementsOf(costMigration),
    ])
      await db.prepare(statement).run();

    await db
      .prepare(
        `INSERT INTO usage_records (request_id, requested_at, provider, executor_type, model, alias, endpoint,
           principal_id, auth_id, auth_type, source, org_id) VALUES ('old', 1, 'codex', 'codex', 'gpt-5', 'gpt-5',
           'POST /v1/responses', 'user:a@example.com', 'codex-a.json', 'oauth', 'a', 'global')`,
      )
      .run();

    for (const statement of [
      ...statementsOf(memberMigration),
      ...statementsOf(privateMigration),
      ...statementsOf(failureMigration),
      ...statementsOf(toolCallsMigration),
    ])
      await db.prepare(statement).run();

    const [row] = await rows();
    expect(row).toMatchObject({ request_id: "old", member_id: null });

    await insertUsageRecord(
      db,
      sampleRecord({
        requestId: "mine",
        requestedAt: 2,
        principalId: "user:a@example.com",
        memberId: "mem-a",
      }),
    );
    await insertUsageRecord(
      db,
      sampleRecord({
        requestId: "theirs",
        requestedAt: 3,
        principalId: "user:b@example.com",
        memberId: "mem-b",
      }),
    );

    const ids = async (filter: Parameters<typeof listUsageRecords>[2]) =>
      (await listUsageRecords(db, GLOBAL_ORG, filter, authIndexOf)).rows.map(
        (record) => record.request_id,
      );

    expect(await ids({ memberIds: ["mem-a"] })).toEqual(["mine"]);
    expect(await ids({ memberIds: [] })).toEqual([]);
    // A member's own records: by member id, and by their Access principal from before members.
    expect(await ids({ own: { memberId: "mem-a", principalId: "user:a@example.com" } })).toEqual([
      "mine",
      "old",
    ]);
    expect(await ids({ own: { memberId: undefined, principalId: "user:b@example.com" } })).toEqual([
      "theirs",
    ]);

    const summary = await summarizeUsage(db, GLOBAL_ORG, { groupBy: "member" }, authIndexOf);
    expect(summary.groups).toEqual(
      expect.arrayContaining(
        ["", "mem-a", "mem-b"].map((key) => expect.objectContaining({ key, requests: 1 })),
      ),
    );
    expect(summary.groups).toHaveLength(3);

    // The index exists, and the migration's index statement is idempotent.
    const indexes = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_records'")
      .all<{ readonly name: string }>();

    expect(indexes.results.map((index) => index.name)).toContain("usage_records_org_member");

    for (const statement of statementsOf(memberMigration).filter((sql) => sql.startsWith("CREATE")))
      await db.prepare(statement).run();
  });
});

describe("migration 0006 (usage private)", () => {
  it("leaves the records written before private credentials shared, and keeps private ones to their owner", async () => {
    await db.prepare("DROP TABLE usage_records").run();

    for (const statement of [
      ...statementsOf(initialMigration),
      ...statementsOf(sessionsMigration),
      ...statementsOf(orgMigration),
      ...statementsOf(costMigration),
      ...statementsOf(memberMigration),
    ])
      await db.prepare(statement).run();

    await db
      .prepare(
        "INSERT INTO usage_records (request_id, requested_at, provider, executor_type, model, alias, endpoint, " +
          "principal_id, auth_id, auth_type, source, org_id, member_id) VALUES ('old', 1, 'codex', 'codex', " +
          "'gpt-5', 'gpt-5', 'POST /v1/responses', 'user:a@example.com', 'codex-a.json', 'oauth', 'a', 'global', 'mem-a')",
      )
      .run();

    for (const statement of [
      ...statementsOf(privateMigration),
      ...statementsOf(failureMigration),
      ...statementsOf(toolCallsMigration),
    ])
      await db.prepare(statement).run();

    const [row] = await rows();
    expect(row).toMatchObject({ request_id: "old", private: 0 });

    await insertUsageRecord(
      db,
      sampleRecord({ requestId: "mine", requestedAt: 2, memberId: "mem-a", private: true }),
    );
    await insertUsageRecord(
      db,
      sampleRecord({ requestId: "theirs", requestedAt: 3, memberId: "mem-b", private: true }),
    );
    await insertUsageRecord(db, sampleRecord({ requestId: "shared", requestedAt: 4 }));

    const ids = async (privateOf?: string) =>
      (
        await listUsageRecords(
          db,
          GLOBAL_ORG,
          privateOf === undefined ? {} : { privateOf },
          authIndexOf,
        )
      ).rows
        .map((record) => record.request_id)
        .toSorted();

    // Without a reader no private record is part of any read; the owner reads theirs only.
    expect(await ids()).toEqual(["old", "shared"]);
    expect(await ids("mem-a")).toEqual(["mine", "old", "shared"]);
    expect(await ids("mem-c")).toEqual(["old", "shared"]);

    const total = async (privateOf?: string) =>
      (
        await summarizeUsage(
          db,
          GLOBAL_ORG,
          { groupBy: "model", ...(privateOf === undefined ? {} : { privateOf }) },
          authIndexOf,
        )
      ).totals.requests;

    expect(await total()).toBe(2);
    expect(await total("mem-a")).toBe(3);

    const seriesRequests = async (privateOf?: string) =>
      (
        await summarizeUsageSeries(
          db,
          GLOBAL_ORG,
          {
            since: 0,
            until: 10 * 86_400_000,
            bucket: "day",
            groupBy: "model",
            ...(privateOf === undefined ? {} : { privateOf }),
          },
          authIndexOf,
        )
      ).reduce((sum, group) => sum + group.points.reduce((n, point) => n + point.requests, 0), 0);

    expect(await seriesRequests()).toBe(2);
    expect(await seriesRequests("mem-a")).toBe(3);

    // The export queue never carries a private record, to anyone.
    const queued = (await popUsageQueue(db, GLOBAL_ORG, 100, 1000)).map(
      (record) => record.request_id,
    );

    expect(queued.toSorted()).toEqual(["old", "shared"]);

    const owned = (await listUsageRecords(db, GLOBAL_ORG, { privateOf: "mem-a" }, authIndexOf))
      .rows;

    expect(owned.find((record) => record.request_id === "mine")?.private).toBe(1);
    expect(owned.find((record) => record.request_id === "shared")?.private).toBe(0);
  });
});

describe("D1 usage sink", () => {
  it("persists the record through ctx.waitUntil without blocking the caller", async () => {
    const pending: Array<Promise<unknown>> = [];

    const ctx = {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    } as unknown as ExecutionContext;

    const record = sampleRecord({
      stream: true,
      ttftMs: 40,
      responseModel: "gpt-5-2025",
      reasoningEffort: "high",
    });

    await Effect.gen(function* () {
      const sink = yield* UsageSink;
      yield* sink.publish(record);
    }).pipe(
      Effect.provide(sink),
      Effect.provideContext(envContext(env)),
      Effect.provideService(WorkerExecutionContext, ctx),
      Effect.runPromise,
    );
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const [row] = await rows();
    expect(row).toMatchObject({
      request_id: record.requestId,
      trace_id: "trace-1",
      requested_at: 1_700_000_000_000,
      latency_ms: 120,
      ttft_ms: 40,
      provider: "codex",
      model: "gpt-5",
      response_model: "gpt-5-2025",
      endpoint: "POST /v1/responses",
      principal_id: "user:dev@example.com",
      stream: 1,
      failed: 0,
      fail_status: null,
      reasoning_effort: "high",
      input_tokens: 100,
      output_tokens: 30,
      reasoning_tokens: 12,
      cache_read_tokens: 40,
      total_tokens: 130,
      accounting_version: 2,
      acct_quality: "complete",
      acct_input_tokens: 100,
      acct_input_uncached_tokens: 60,
      acct_cache_read_tokens: 40,
      acct_output_tokens: 30,
      acct_output_non_reasoning_tokens: 18,
      acct_output_reasoning_tokens: 12,
      exported_at: null,
    });
  });

  it("stores a failure's status, type and code, never a body, and is idempotent per request id", async () => {
    const record = sampleRecord({
      failed: true,
      fail: { statusCode: 429, type: "rate_limit_error", code: "insufficient_quota" },
    });

    await insertUsageRecord(db, record);
    await insertUsageRecord(db, record);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      failed: 1,
      fail_status: 429,
      fail_type: "rate_limit_error",
      fail_code: "insufficient_quota",
      fail_body: null,
    });

    expect(rowToPayload(stored[0] as UsageRow, authIndexOf).fail).toEqual({
      status_code: 429,
      type: "rate_limit_error",
      code: "insufficient_quota",
    });
  });

  it("never fails the request when the write fails and does nothing without a binding", async () => {
    const warnings: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];

    const capture = Logger.layer([
      Logger.make((options) => {
        warnings.push({
          message: options.message,
          annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
        });
      }),
    ]);

    const pending: Array<Promise<unknown>> = [];

    const ctx = {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    } as unknown as ExecutionContext;

    const broken = {
      ...env,
      USAGE: {
        prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("D1 down")) }) }),
      },
    } as unknown as Cloudflare.Env;

    const record = sampleRecord();

    const publish = (bindings: Cloudflare.Env) =>
      Effect.gen(function* () {
        yield* (yield* UsageSink).publish(record);
      }).pipe(
        Effect.provide(sink),
        Effect.provide(capture),
        Effect.provideContext(envContext(bindings)),
        Effect.provideService(WorkerExecutionContext, ctx),
        Effect.runPromise,
      );

    await publish(broken);
    await Promise.all(pending);
    expect(warnings).toEqual([
      {
        message: ["usage record write failed"],
        annotations: { requestId: record.requestId, error: "D1 down" },
      },
    ]);
    await publish({ ...env, USAGE: undefined } as unknown as Cloudflare.Env);
    expect(pending).toHaveLength(1);
  });

  it("falls back to awaiting the write when waitUntil is unavailable", async () => {
    const ctx = {
      waitUntil: () => {
        throw new Error("invocation finished");
      },
    } as unknown as ExecutionContext;

    await Effect.gen(function* () {
      yield* (yield* UsageSink).publish(sampleRecord());
    }).pipe(
      Effect.provide(sink),
      Effect.provideContext(envContext(env)),
      Effect.provideService(WorkerExecutionContext, ctx),
      Effect.runPromise,
    );
    expect(await rows()).toHaveLength(1);
  });

  it("persists the Claude independent breakdown parsed from the upstream usage", async () => {
    const detail = parseClaudeUsage(
      '{"usage":{"input_tokens":2,"cache_creation_input_tokens":831,"cache_read_input_tokens":44225,"output_tokens":244,"output_tokens_details":{"thinking_tokens":40}}}',
    );

    await insertUsageRecord(
      db,
      sampleRecord({ provider: "claude", executorType: "claude", detail }),
    );
    expect((await rows())[0]).toMatchObject({
      total_tokens: 45302,
      acct_quality: "complete",
      acct_total_tokens: 45302,
      acct_input_tokens: 45058,
      acct_input_uncached_tokens: 2,
      acct_cache_read_tokens: 44225,
      acct_cache_write_tokens: 831,
      acct_output_non_reasoning_tokens: 204,
      acct_output_reasoning_tokens: 40,
    });
  });

  it("derives a breakdown for records that only carry raw buckets", () => {
    const raw = { ...sampleRecord().detail, totalTokens: 0 };

    const row = recordToRow(
      sampleRecord({ provider: "gemini", executorType: "gemini", detail: raw }),
    );

    // Gemini: reasoning is separate from the candidates count, so it adds to the output.
    expect(row).toMatchObject({
      total_tokens: 142,
      acct_total_tokens: 142,
      acct_output_tokens: 42,
    });
    const inconsistent = recordToRow(sampleRecord({ provider: "gemini", executorType: "gemini" }));
    expect(inconsistent).toMatchObject({
      acct_quality: "inconsistent",
      acct_unclassified_tokens: 130,
    });
    expect(
      ensureTokenBreakdown(sampleRecord().detail, "codex", "codex").tokenBreakdown?.totalTokens,
    ).toBe(130);
  });
});

describe("export queue (GET /observability/usage/queue)", () => {
  it("pops the oldest unexported records exactly once, in order", async () => {
    for (let index = 0; index < 5; index += 1) {
      await insertUsageRecord(
        db,
        sampleRecord({ requestId: `r${index}`, requestedAt: 1000 + index }),
      );
    }

    const first = await popUsageQueue(db, GLOBAL_ORG, 2, 5000);
    expect(first.map((row) => row.request_id)).toEqual(["r0", "r1"]);
    expect(first.every((row) => row.exported_at === 5000)).toBe(true);
    const second = await popUsageQueue(db, GLOBAL_ORG, 10, 6000);
    expect(second.map((row) => row.request_id)).toEqual(["r2", "r3", "r4"]);
    expect(await popUsageQueue(db, GLOBAL_ORG, 1, 7000)).toEqual([]);
    // Exported records stay available for the listing endpoints.
    expect(await rows()).toHaveLength(5);
  });

  it("renders the Go queue payload shape", async () => {
    await insertUsageRecord(db, sampleRecord({ requestId: "r1", ttftMs: 15, stream: true }));
    const [row] = await popUsageQueue(db, GLOBAL_ORG, 1, 1);
    const payload = rowToPayload(row as UsageRow, authIndexOf);
    expect(payload).toMatchObject({
      timestamp: "2023-11-14T22:13:20.000Z",
      latency_ms: 120,
      ttft_ms: 15,
      source: "dev@example.com",
      tokens: {
        input_tokens: 100,
        output_tokens: 30,
        reasoning_tokens: 12,
        cached_tokens: 40,
        cache_read_tokens: 40,
        cache_read_tokens_present: true,
        cache_creation_tokens: 0,
        total_tokens: 130,
      },
      failed: false,
      generate: true,
      stream: true,
      fail: { status_code: 200 },
      accounting_version: 2,
      token_breakdown: {
        schema_version: 2,
        quality: "complete",
        total_tokens: 130,
        input: {
          total_tokens: 100,
          uncached_tokens: 60,
          cache_read_tokens: 40,
          cache_write_tokens: 0,
        },
        output: { total_tokens: 30, non_reasoning_tokens: 18, reasoning_tokens: 12 },
        unclassified_tokens: 0,
      },
      provider: "codex",
      executor_type: "codex",
      model: "gpt-5",
      alias: "gpt-5",
      endpoint: "POST /v1/responses",
      auth_type: "oauth",
      api_key: "user:dev@example.com",
      request_id: "r1",
      trace_id: "trace-1",
      reasoning_effort: "",
      service_tier: "auto",
    });
    expect(payload["auth_index"]).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("listing and summary", () => {
  const seed = async () => {
    const base = 1_700_000_000_000;
    const day = 86_400_000;

    const records = [
      sampleRecord({ requestId: "a", requestedAt: base, model: "gpt-5", principalId: "user:a" }),
      sampleRecord({
        requestId: "b",
        requestedAt: base + 1000,
        model: "gpt-5",
        principalId: "user:b",
      }),
      sampleRecord({
        requestId: "c",
        requestedAt: base + day,
        model: "gpt-4",
        principalId: "user:a",
        failed: true,
        fail: { statusCode: 500 },
        detail: {
          ...sampleRecord().detail,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
        },
      }),
    ];

    for (const record of records) await insertUsageRecord(db, record);

    return { base, day };
  };

  it("lists newest first with keyset pagination and filters", async () => {
    const { base } = await seed();
    const page1 = await listUsageRecords(db, GLOBAL_ORG, { limit: 2 }, authIndexOf);
    expect(page1.rows.map((row) => row.request_id)).toEqual(["c", "b"]);
    expect(page1.nextBefore).toBeDefined();

    const page2 = await listUsageRecords(
      db,
      GLOBAL_ORG,
      { limit: 2, before: page1.nextBefore as string },
      authIndexOf,
    );

    expect(page2.rows.map((row) => row.request_id)).toEqual(["a"]);
    expect(page2.nextBefore).toBeUndefined();
    expect(
      (await listUsageRecords(db, GLOBAL_ORG, { model: "gpt-5" }, authIndexOf)).rows.map(
        (row) => row.request_id,
      ),
    ).toEqual(["b", "a"]);
    expect(
      (
        await listUsageRecords(db, GLOBAL_ORG, { principal: "user:a", failed: true }, authIndexOf)
      ).rows.map((row) => row.request_id),
    ).toEqual(["c"]);
    expect(
      (
        await listUsageRecords(
          db,
          GLOBAL_ORG,
          { since: base + 500, until: base + 2000 },
          authIndexOf,
        )
      ).rows.map((row) => row.request_id),
    ).toEqual(["b"]);
  });

  it("resolves an auth_index through the live credential first, through D1 only for gone ones", async () => {
    await insertUsageRecord(db, sampleRecord({ requestId: "live", authId: "live.json" }));
    await insertUsageRecord(db, sampleRecord({ requestId: "gone", authId: "gone.json" }));

    // A D1 that fails every query: the live path must not touch it.
    const noDb = {
      prepare: () => {
        throw new Error("D1 must not be read for a live credential");
      },
    } as unknown as D1Database; // SAFETY: only `prepare` is reachable, and it throws.

    expect(
      await resolveAuthIds(
        noDb,
        GLOBAL_ORG,
        { authIndex: authIndexOf("live.json"), liveAuthId: "live.json" },
        authIndexOf,
      ),
    ).toEqual(["live.json"]);

    // A deleted credential (no live id) or a live id of another index: the distinct stored ids decide.
    expect(
      await resolveAuthIds(db, GLOBAL_ORG, { authIndex: authIndexOf("gone.json") }, authIndexOf),
    ).toEqual(["gone.json"]);
    expect(
      await resolveAuthIds(
        db,
        GLOBAL_ORG,
        { authIndex: authIndexOf("gone.json"), liveAuthId: "live.json" },
        authIndexOf,
      ),
    ).toEqual(["gone.json"]);
    expect(
      await resolveAuthIds(db, GLOBAL_ORG, { authIndex: "0000000000000000" }, authIndexOf),
    ).toEqual([]);
    expect(await resolveAuthIds(noDb, GLOBAL_ORG, {}, authIndexOf)).toBeUndefined();

    expect(
      (
        await listUsageRecords(
          db,
          GLOBAL_ORG,
          { authIndex: authIndexOf("live.json"), liveAuthId: "live.json" },
          authIndexOf,
        )
      ).rows.map((row) => row.request_id),
    ).toEqual(["live"]);
  });

  it("summarises the v2 buckets overall and per group", async () => {
    await seed();
    const byModel = await summarizeUsage(db, GLOBAL_ORG, { groupBy: "model" }, authIndexOf);
    expect(byModel.totals).toMatchObject({
      requests: 3,
      failed: 1,
      input_tokens: 200,
      uncached_input_tokens: 120,
      cache_read_tokens: 80,
      output_tokens: 60,
      reasoning_tokens: 24,
      total_tokens: 260,
    });
    expect(byModel.groups.map((group) => [group.key, group.requests, group.total_tokens])).toEqual([
      ["gpt-5", 2, 260],
      ["gpt-4", 1, 0],
    ]);
    const byDay = await summarizeUsage(db, GLOBAL_ORG, { groupBy: "day" }, authIndexOf);
    expect(byDay.groups.map((group) => group.key)).toEqual(["2023-11-15", "2023-11-14"]);

    const empty = await summarizeUsage(
      db,
      GLOBAL_ORG,
      { groupBy: "provider", since: 0, until: 1 },
      authIndexOf,
    );

    expect(empty.totals.requests).toBe(0);
    expect(empty.groups).toEqual([]);
  });
});

describe("retention", () => {
  const day = 86_400_000;

  it("prunes the records of one org older than the cutoff and leaves the other orgs alone", async () => {
    const acme = OrgId.make("acme");

    for (const at of [1000, 2000, 3000]) {
      await insertUsageRecord(db, sampleRecord({ requestedAt: at, orgId: acme }));
      await insertUsageRecord(db, sampleRecord({ requestedAt: at }));
    }

    expect(await pruneUsageRecords(db, acme, 2500)).toBe(2);
    expect((await rows()).map((row) => [row.org_id, row.requested_at])).toEqual([
      ["global", 1000],
      ["global", 2000],
      ["acme", 3000],
      ["global", 3000],
    ]);
  });

  describe("the scheduled job", () => {
    const org = () => OrgId.make(`ret-${crypto.randomUUID().slice(0, 8)}`);

    /** An org of the Platform registry with `days` of retention (`null`: none), as the job lists it. */
    const registered = async (id: OrgId, days: number | null) => {
      const registry = platformOf(env);
      const created = await registry.createOrg({ slug: id, name: id, id }, 1);

      if (!created.ok) throw new Error(created.message);
      await registry.setUsageRetention(id, days);
    };

    const run = (now: number) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);

        return yield* pruneExpiredUsage;
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideContext(envContext(env)),
        Effect.runPromise,
      );

    it("deletes records past each org's own period and keeps everything of an org with none", async () => {
      const now = 1000 * day;
      const month = org();
      const quarter = org();
      const forever = org();

      await registered(month, 30);
      await registered(quarter, 90);
      await registered(forever, null);

      for (const [orgId, age, name] of [
        [month, 31, "month-old"],
        [month, 29, "month-recent"],
        [quarter, 31, "quarter-31"],
        [quarter, 91, "quarter-old"],
        [forever, 2000, "forever-ancient"],
        // `global` has no period in a fresh registry: its history stays.
        [GLOBAL_ORG, 2000, "global-ancient"],
      ] as const)
        await insertUsageRecord(
          db,
          sampleRecord({ requestId: name, orgId, requestedAt: now - age * day }),
        );

      expect(await run(now)).toBe(2);
      expect((await rows()).map((row) => row.request_id).toSorted()).toEqual([
        "forever-ancient",
        "global-ancient",
        "month-recent",
        "quarter-31",
      ]);
    });

    it("counts the period from the clock, so a record is pruned the day after it passes", async () => {
      const id = org();
      await registered(id, 10);
      await insertUsageRecord(
        db,
        sampleRecord({ requestId: "edge", orgId: id, requestedAt: 100 * day }),
      );

      expect(await run(110 * day)).toBe(0);
      expect(await run(110 * day + 1)).toBe(1);
    });

    it("is registered as a cron task of the whole deployment", () => {
      expect(scheduledTasks.find((task) => task.name === "usage-retention")?.scope).toBe(
        "deployment",
      );
    });
  });
});

describe("usage session identity and base URL", () => {
  it("stores the session, parent and base URL and exports canonical UUIDs", async () => {
    await insertUsageRecord(
      db,
      sampleRecord({
        sessionId: "claude:123E4567-E89B-12D3-A456-426614174000",
        parentSessionId: "lcp:v1:abcdef",
        baseUrl: "https://api.example.test/v1",
      }),
    );
    const [row] = await rows();
    expect(row).toMatchObject({
      session_id: "claude:123E4567-E89B-12D3-A456-426614174000",
      parent_session_id: "lcp:v1:abcdef",
      base_url: "https://api.example.test/v1",
    });
    const payload = rowToPayload(row as UsageRow, authIndexOf);
    expect(payload).toMatchObject({
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      base_url: "https://api.example.test/v1",
    });
    // A non-UUID parent is projected to a deterministic UUIDv8, like `NormalizeToCanonicalUUID`.
    expect(payload).toHaveProperty(
      "parent_session_id",
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    );
  });

  it("omits the fields without a session and drops a parent equal to the session", async () => {
    await insertUsageRecord(db, sampleRecord());
    await insertUsageRecord(
      db,
      sampleRecord({
        sessionId: "thread:abc",
        parentSessionId: "thread:abc",
        requestedAt: 1_700_000_000_001,
      }),
    );
    const [plain, same] = (await rows()).map((row) => rowToPayload(row, authIndexOf));
    expect(plain).not.toHaveProperty("session_id");
    expect(plain).not.toHaveProperty("base_url");
    expect(same).toHaveProperty("session_id");
    expect(same).not.toHaveProperty("parent_session_id");
  });
});

describe("tool calls (#199)", () => {
  const acme = OrgId.make("acme-tools");

  /** A tool call's record as Tools writes it (`packages/tools/src/usage/record.ts`). */
  const insertToolCall = async (fields: {
    readonly requestId: string;
    readonly requestedAt: number;
    readonly toolkit?: string;
    readonly tool?: string;
    readonly memberId?: string;
    readonly private?: boolean;
    readonly costMicros?: number;
    readonly org?: OrgId;
  }) => {
    const toolkit = fields.toolkit ?? "tk_a";

    await db
      .prepare(
        `INSERT INTO usage_records (request_id, requested_at, latency_ms, provider, executor_type, model, alias,
           endpoint, principal_id, org_id, member_id, private, auth_id, auth_type, source, failed, cost_micros,
           unpriced, area, toolkit_id, tool_id, tool_outcome, request_bytes, response_bytes)
         VALUES (?, ?, 7, '', '', '', '', 'POST /mcp', 'key:k1', ?, ?, ?, '', 'shared', '', 0, ?, 0, 'tools', ?, ?,
           'success', 12, 34)`,
      )
      .bind(
        fields.requestId,
        fields.requestedAt,
        fields.org ?? acme,
        fields.memberId ?? null,
        fields.private === true ? 1 : 0,
        fields.costMicros ?? 0,
        toolkit,
        `${toolkit}:${fields.tool ?? "search"}`,
      )
      .run();
  };

  /** Two model attempts and three tool calls of `acme`. */
  const mixed = async () => {
    await insertUsageRecord(db, sampleRecord({ requestId: "m1", requestedAt: 1000, orgId: acme }));
    await insertUsageRecord(db, sampleRecord({ requestId: "m2", requestedAt: 2000, orgId: acme }));
    await insertToolCall({ requestId: "t1", requestedAt: 1500, costMicros: 1_000 });
    await insertToolCall({ requestId: "t2", requestedAt: 2500, tool: "scrape", costMicros: 5_000 });
    await insertToolCall({ requestId: "t3", requestedAt: 3000, toolkit: "tk_b", tool: "ping" });
  };

  const ids = (page: { readonly rows: ReadonlyArray<UsageRow> }) =>
    page.rows.map((row) => row.request_id);

  it("are left out of every read that does not ask for them, and of the export queue", async () => {
    await mixed();

    expect(ids(await listUsageRecords(db, acme, {}, authIndexOf))).toEqual(["m2", "m1"]);
    expect(
      (await summarizeUsage(db, acme, { groupBy: "model" }, authIndexOf)).totals.requests,
    ).toBe(2);
    expect(
      (
        await summarizeUsageSeries(
          db,
          acme,
          { since: 0, until: 10_000, bucket: "hour", groupBy: "model" },
          authIndexOf,
        )
      ).flatMap((series) => series.points.map((point) => point.requests)),
    ).toEqual([2]);
    expect(await unpricedModels(db, acme, {}, authIndexOf)).toEqual([]);

    const exported = await popUsageQueue(db, acme, 100, 9000);

    expect(exported.map((row) => row.request_id)).toEqual(["m1", "m2"]);
    expect(await popUsageQueue(db, acme, 100, 9500)).toEqual([]);
    // A tool call is never marked exported.
    expect(
      (await rows()).filter((row) => row.area === "tools").map((row) => row.exported_at),
    ).toEqual([null, null, null]);
  });

  it("are read beside model attempts, by area, toolkit and tool, with what their record holds", async () => {
    await mixed();

    expect(ids(await listUsageRecords(db, acme, { area: "tools" }, authIndexOf))).toEqual([
      "t3",
      "t2",
      "t1",
    ]);
    expect(ids(await listUsageRecords(db, acme, { area: "all" }, authIndexOf))).toEqual([
      "t3",
      "t2",
      "m2",
      "t1",
      "m1",
    ]);
    // A toolkit or a tool asks for tool calls.
    expect(ids(await listUsageRecords(db, acme, { toolkit: "tk_a" }, authIndexOf))).toEqual([
      "t2",
      "t1",
    ]);
    expect(ids(await listUsageRecords(db, acme, { tool: "tk_b:ping" }, authIndexOf))).toEqual([
      "t3",
    ]);

    const [latest] = (await listUsageRecords(db, acme, { tool: "tk_a:scrape" }, authIndexOf)).rows;

    expect(latest === undefined ? undefined : rowToPayload(latest, authIndexOf)).toMatchObject({
      area: "tools",
      toolkit_id: "tk_a",
      tool_id: "tk_a:scrape",
      outcome: "success",
      credential: "shared",
      request_bytes: 12,
      response_bytes: 34,
      auth_index: "",
      api_key: "key:k1",
      latency_ms: 7,
      cost_micros: 5_000,
      unpriced: false,
      failed: false,
    });

    const byTool = await summarizeUsage(db, acme, { groupBy: "tool", area: "tools" }, authIndexOf);

    expect(byTool.totals).toMatchObject({ requests: 3, cost_micros: 6_000, total_tokens: 0 });
    expect(byTool.groups.map((group) => [group.key, group.requests, group.cost_micros])).toEqual([
      ["tk_a:scrape", 1, 5_000],
      ["tk_a:search", 1, 1_000],
      ["tk_b:ping", 1, 0],
    ]);

    const byArea = await summarizeUsage(db, acme, { groupBy: "area", area: "all" }, authIndexOf);

    expect(Object.fromEntries(byArea.groups.map((group) => [group.key, group.requests]))).toEqual({
      models: 2,
      tools: 3,
    });

    const byToolkit = await summarizeUsageSeries(
      db,
      acme,
      { since: 0, until: 10_000, bucket: "hour", groupBy: "toolkit", area: "tools" },
      authIndexOf,
    );

    expect(byToolkit.map((series) => [series.key, series.points[0]?.requests])).toEqual([
      ["tk_a", 2],
      ["tk_b", 1],
    ]);
  });

  it("keep a private call to its member, out of every org-wide read", async () => {
    await insertToolCall({
      requestId: "mine",
      requestedAt: 1000,
      memberId: "alice",
      private: true,
    });
    await insertToolCall({ requestId: "org", requestedAt: 2000, memberId: "bob" });

    const read = async (privateOf?: string) =>
      ids(
        await listUsageRecords(
          db,
          acme,
          { area: "tools", ...(privateOf === undefined ? {} : { privateOf }) },
          authIndexOf,
        ),
      );

    expect(await read()).toEqual(["org"]);
    expect(await read("alice")).toEqual(["org", "mine"]);
    expect(await read("bob")).toEqual(["org"]);
  });

  it("are pruned with the org's records past its retention, and deleted with the org", async () => {
    await mixed();
    await insertToolCall({ requestId: "other", requestedAt: 1000, org: OrgId.make("other") });

    expect(await pruneUsageRecords(db, acme, 2200)).toBe(3);
    expect(ids(await listUsageRecords(db, acme, { area: "all" }, authIndexOf))).toEqual([
      "t3",
      "t2",
    ]);

    expect(await deleteOrgUsage(db, acme)).toMatchObject({ removed: 2, complete: true });
    expect((await rows()).map((row) => row.request_id)).toEqual(["other"]);
  });
});
