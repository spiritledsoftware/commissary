// Runs' objects sharing one isolate (#228): their first turns, started at once on a cold isolate, each run on their own
// object. The pi packages load with the Worker (`runs/pi.ts`, imported statically, and pi-ai's completions without its
// lazy `import()`): an import still pending when a second object awaited it resumed that object in the first one's I/O
// context, where its storage could not be reached, failing its turn and leaving its harness unable to close, so its
// deletion never finished. This file starts the isolate's first runs, so nothing is loaded before them; each object
// here has no client API behind it (test/worker.ts), so its turn fails at its first model call, and is cancelled.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newOrgId } from "@commissary/core";
import { agentRunOf } from "../src/env.ts";
import { agentBody } from "./testing.ts";

const OWNER = { role: "owner" as const, sensitive: false };

const FOUND = { modelServed: true, unknownToolkits: [] };

/** How many runs start at once. */
const RUNS = 4;

describe("runs' objects in one isolate", () => {
  it("start their first turns at once, each on its own object, and are each cancelled, shown and deleted", async () => {
    const id = newOrgId();
    const stub = env.CONTROL_PLANE.getByName(id);

    await stub.setMembershipSettings({ privateAgents: true });

    const added = await stub.addMember(
      { email: "alice@example.com", role: "member" },
      OWNER,
      "test",
    );

    if (!added.ok) throw new Error(added.message);
    const alice = { member: added.value.id, admin: false };

    const agent = await stub
      .agents()
      .createAgent(alice, agentBody("helper", "claude-sonnet-4"), FOUND, "test");

    if (!agent.ok) throw new Error(agent.message);

    const runs = await Promise.all(
      Array.from({ length: RUNS }, async () => {
        const run = await stub.agents().startRun(alice, agent.value.id, "chat", undefined);

        if (!run.ok) throw new Error(run.message);

        return run.value.run.id;
      }),
    );

    // Every object starts its first turn at the same time, loading the harness together.
    const starts = await Promise.all(
      runs.map(async (run) => await agentRunOf(env, id, run).start({ org: id, id: run }, "hello")),
    );

    expect(starts).toEqual(runs.map(() => expect.objectContaining({ ok: true })));

    // Each reaches its own storage: its turn is cancelled and shown as its own.
    expect(
      await Promise.all(runs.map(async (run) => await agentRunOf(env, id, run).cancel())),
    ).toEqual(runs.map(() => expect.objectContaining({ ok: true })));

    for (const run of runs)
      expect(await agentRunOf(env, id, run).show()).toMatchObject({
        ok: true,
        value: {
          state: "idle",
          turns: [{ status: expect.stringMatching(/^(cancelled|failed)$/) }],
        },
      });

    // And each is deleted: its harness closes and its storage goes.
    await Promise.all(runs.map(async (run) => await agentRunOf(env, id, run).purge()));

    for (const run of runs)
      expect(await agentRunOf(env, id, run).show()).toMatchObject({
        ok: false,
        error: "not_found",
      });
  });
});
