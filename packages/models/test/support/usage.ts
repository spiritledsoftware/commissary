// Helpers for the usage tests: the D1 schema (the real migration file) and sample records.
import { env } from "cloudflare:workers";
import initial from "../../../../migrations/usage/0001_usage_records.sql?raw";
import sessions from "../../../../migrations/usage/0002_usage_sessions.sql?raw";
import orgs from "../../../../migrations/usage/0003_usage_org.sql?raw";
import costs from "../../../../migrations/usage/0004_usage_cost.sql?raw";
import members from "../../../../migrations/usage/0005_usage_member.sql?raw";
import privates from "../../../../migrations/usage/0006_usage_private.sql?raw";
import failures from "../../../../migrations/usage/0007_usage_failure.sql?raw";
import toolCalls from "../../../../migrations/usage/0010_usage_tool_calls.sql?raw";
import agentRuns from "../../../../migrations/usage/0011_usage_agent_runs.sql?raw";
import browserTime from "../../../../migrations/usage/0012_usage_browser_time.sql?raw";
import privateAgentRuns from "../../../../migrations/usage/0013_usage_private_agent_runs.sql?raw";
import { GLOBAL_ORG } from "@commissary/core";
import { emptyUsageDetail, type UsageRecord } from "../../src/usage/record.ts";

export const statementsOf = (sql: string): string[] =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

/**
 * Applies the checked-in migrations of the usage records (0001 to 0007, 0010 to 0013) to the test D1 database
 * (idempotent) and empties the table. Better Auth's old `auth_` tables (0008, dropped by 0009) are not part of the test
 * schema. `ALTER TABLE ... ADD COLUMN` has no IF NOT EXISTS, so a duplicate-column failure of an already migrated
 * database is ignored.
 */
export const resetUsageDb = async (db: D1Database = env.USAGE): Promise<D1Database> => {
  for (const statement of [
    ...statementsOf(initial),
    ...statementsOf(sessions),
    ...statementsOf(orgs),
    ...statementsOf(costs),
    ...statementsOf(members),
    ...statementsOf(privates),
    ...statementsOf(failures),
    ...statementsOf(toolCalls),
    ...statementsOf(agentRuns),
    ...statementsOf(browserTime),
    ...statementsOf(privateAgentRuns),
  ]) {
    try {
      await db
        .prepare(
          statement.replace(/^CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/, "CREATE $1 IF NOT EXISTS "),
        )
        .run();
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }

  await db.prepare("DELETE FROM usage_records").run();

  return db;
};

export const sampleRecord = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  requestId: crypto.randomUUID(),
  traceId: "trace-1",
  provider: "codex",
  executorType: "codex",
  model: "gpt-5",
  alias: "gpt-5",
  endpoint: "POST /v1/responses",
  principalId: "user:dev@example.com",
  orgId: GLOBAL_ORG,
  authId: "codex-a.json",
  authType: "oauth",
  source: "dev@example.com",
  stream: false,
  requestedAt: 1_700_000_000_000,
  latencyMs: 120,
  failed: false,
  detail: {
    ...emptyUsageDetail,
    inputTokens: 100,
    outputTokens: 30,
    reasoningTokens: 12,
    cachedTokens: 40,
    cacheReadTokens: 40,
    totalTokens: 130,
  },
  serviceTier: "auto",
  ...overrides,
});
