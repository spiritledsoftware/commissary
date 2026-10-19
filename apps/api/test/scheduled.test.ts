import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CurrentOrg, GLOBAL_ORG, OrgId, type ScheduledTask } from "@commissary/core";
import { platformOf } from "@commissary/state";
import { alarmOf } from "@commissary/state/testing";
import { runScheduledTasks, type ScheduledServices, scheduledTasks } from "../src/scheduled.ts";
import worker from "../src/index.ts";
import { ModelsEnv, scheduledTasks as modelsTasks } from "@commissary/models/api";
import { scheduledTasks as toolsTasks } from "@commissary/tools/api";
import { FULL_ACCESS } from "@commissary/models/testing";

const ctx = {} as unknown as ExecutionContext;

describe("scheduled dispatch", () => {
  it("registers the model catalog refresh", () => {
    expect(scheduledTasks.map((task) => task.name)).toContain("model-catalog-refresh");
  });

  it("runs its own task, then the Models tasks and the Tools tasks in their order", () => {
    expect(scheduledTasks.map((task) => task.name)).toEqual([
      "api-key-expiry",
      ...modelsTasks.map((task) => task.name),
      ...toolsTasks.map((task) => task.name),
    ]);
    // The API key sweep (apps/app/test/api-keys.test.ts) covers every org, also one nobody opens.
    expect(scheduledTasks.find((task) => task.name === "api-key-expiry")?.scope).toBe("org");
  });

  it("runs every task in order, gives them the invocation's bindings and isolates failures", async () => {
    const log: string[] = [];

    const tasks: ScheduledTask<ScheduledServices>[] = [
      { name: "first", scope: "deployment", run: Effect.sync(() => void log.push("first")) },
      { name: "boom", scope: "deployment", run: Effect.fail(new Error("boom")) },
      { name: "defect", scope: "deployment", run: Effect.die("defect") },
      {
        name: "last",
        scope: "deployment",
        run: Effect.gen(function* () {
          const bindings = yield* ModelsEnv;
          log.push(bindings === env ? "last:env" : "last:other-env");
        }),
      },
    ];

    await runScheduledTasks(tasks, env, ctx);
    expect(log).toEqual(["first", "last:env"]);
  });

  it("runs org jobs once per org with that org set, deployment jobs once", async () => {
    const log: string[] = [];
    const acme = OrgId.make("acme");
    const other = OrgId.make("other");

    const tasks: ScheduledTask<ScheduledServices>[] = [
      { name: "shared", scope: "deployment", run: Effect.sync(() => void log.push("shared")) },
      {
        name: "per-org",
        scope: "org",
        run: Effect.gen(function* () {
          const org = yield* CurrentOrg;

          if (org === acme) return yield* Effect.fail(new Error("acme down"));
          log.push(`per-org:${org}`);
        }),
      },
      {
        name: "after",
        scope: "org",
        run: Effect.gen(function* () {
          log.push(`after:${yield* CurrentOrg}`);
        }),
      },
    ];

    await runScheduledTasks(tasks, env, ctx, [acme, other]);
    expect(log).toEqual(["shared", "per-org:other", "after:acme", "after:other"]);
  });

  it("reads the orgs of the Platform registry: global first, then every org created", async () => {
    const created = await platformOf(env).createOrg({ slug: "cron-org", name: "Cron" }, 1);

    if (!created.ok) throw new Error(created.message);
    const log: string[] = [];

    const tasks: ScheduledTask<ScheduledServices>[] = [
      {
        name: "per-org",
        scope: "org",
        run: Effect.gen(function* () {
          log.push(yield* CurrentOrg);
        }),
      },
    ];

    await runScheduledTasks(tasks, env, ctx);
    expect(log[0]).toBe(GLOBAL_ORG);
    expect(log).toContain(created.org.id);
    expect(log).toHaveLength(new Set(log).size);
  });

  it("keeps running for global, and the deployment jobs, when the registry cannot be reached", async () => {
    const log: string[] = [];

    const down = {
      ...env,
      PLATFORM: {
        getByName: () => ({
          listOrgs: async () => {
            throw new Error("down");
          },
        }),
      },
    } as unknown as Env;

    const tasks: ScheduledTask<ScheduledServices>[] = [
      { name: "shared", scope: "deployment", run: Effect.sync(() => void log.push("shared")) },
      {
        name: "per-org",
        scope: "org",
        run: Effect.gen(function* () {
          log.push(`per-org:${yield* CurrentOrg}`);
        }),
      },
    ];

    await runScheduledTasks(tasks, down, ctx);
    expect(log).toEqual(["shared", `per-org:${GLOBAL_ORG}`]);
  });

  it("runs every credential job per org and the shared catalog once", () => {
    const scopes = Object.fromEntries(scheduledTasks.map((task) => [task.name, task.scope]));

    expect(scopes).toMatchObject({
      "model-catalog-refresh": "deployment",
      "antigravity-version": "deployment",
      "antigravity-models": "org",
      "usage-retention": "deployment",
      "devin-user-status": "org",
      "credential-refresh-sweep": "org",
      "quota-check": "org",
    });
  });
});

describe("the scheduled handler", () => {
  const HOUR = 3_600_000;

  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

  // No provider is asked: the refresh is not due. Effect's FetchHttpClient resolves `globalThis.fetch` once, so the
  // stand-in stays for the whole file.
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = async () => new Response("no upstream configured", { status: 500 });
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("sweeps the global ControlPlane", async () => {
    const global = env.CONTROL_PLANE.getByName("global");
    await global.models().importAuthFile(
      "claude-a.json",
      {
        type: "claude",
        email: "me@x.com",
        access_token: "sk-ant-oat-old",
        refresh_token: "rt-1",
        expired: iso(Date.now() + 10 * HOUR),
      },
      {},
      FULL_ACCESS,
    );
    await runInDurableObject(global, (_instance, state) => state.storage.deleteAlarm());
    const ctx = createExecutionContext();
    await worker.scheduled?.(
      { cron: "0 */3 * * *", scheduledTime: Date.now(), noRetry() {} },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await alarmOf(global)).not.toBeNull();
  });
});
