// The hosted Agents area's tables, which a ControlPlane from before its removal (ADR 0048) still holds: it drops them,
// with their indexes and rows, when it next starts (apps/state/src/control-plane.ts), and leaves every other table.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { OrgId } from "@commissary/core";

const RETIRED = [
  "agents",
  "agent_grants",
  "agent_runs",
  "agent_run_purges",
  "agent_triggers",
  "agent_schedule_objects",
  "sandbox_run_calls",
] as const;

const tablesOf = async (stub: DurableObjectStub): Promise<ReadonlyArray<string>> =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((table) => table.name),
  );

describe("a ControlPlane that still holds the retired Agents tables", () => {
  it("drops them, and their indexes, when it starts again, and keeps its other tables", async () => {
    const stub = env.CONTROL_PLANE.getByName(
      OrgId.make(`retired-${crypto.randomUUID().slice(0, 8)}`),
    );

    const kept = await tablesOf(stub);

    expect(kept).toContain("members");

    await runInDurableObject(stub, (_instance, state) => {
      for (const table of RETIRED) {
        state.storage.sql.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, agent_id TEXT)`);
        state.storage.sql.exec(`CREATE INDEX ${table}_agent ON ${table} (agent_id)`);
        state.storage.sql.exec(`INSERT INTO ${table} (id, agent_id) VALUES ('x', 'y')`);
      }
    });
    expect(await tablesOf(stub)).toEqual(expect.arrayContaining([...RETIRED]));

    await evictDurableObject(stub);

    const after = await tablesOf(stub);

    for (const table of RETIRED) expect(after).not.toContain(table);
    expect(after).toEqual(expect.arrayContaining([...kept]));

    const indexes = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%\\_agent' ESCAPE '\\'",
        )
        .toArray(),
    );

    expect(indexes).toEqual([]);
  });
});
