// The retired hosted agents' tombstone classes (src/retired-objects.ts): an object an earlier release left behind
// empties itself, alarm included, when it is next constructed, which any call it receives does.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const left = async (stub: DurableObjectStub) =>
  await runInDurableObject(stub, async (_instance, state) => ({
    keys: [...(await state.storage.list()).keys()],
    alarm: await state.storage.getAlarm(),
  }));

const leaveBehind = async (stub: DurableObjectStub) =>
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("run", { id: "run_1" });
    await state.storage.setAlarm(Date.now() + 3_600_000);
  });

describe("the retired Durable Object classes", () => {
  it.each([
    ["AgentRun", env.AGENT_RUN],
    ["AgentSchedule", env.AGENT_SCHEDULE],
  ] as const)("%s forgets its alarm and storage when it wakes", async (_name, namespace) => {
    const stub = namespace.getByName("left-behind");

    await leaveBehind(stub);
    expect((await left(stub)).keys).toEqual(["run"]);

    await evictDurableObject(stub);
    expect(await left(stub)).toEqual({ keys: [], alarm: null });
  });

  it("answers a request with 410 Gone", async () => {
    const response = await env.AGENT_RUN.getByName("asked").fetch("https://retired.test/");

    expect(response.status).toBe(410);
    expect(await response.text()).toBe("retired");
  });
});
