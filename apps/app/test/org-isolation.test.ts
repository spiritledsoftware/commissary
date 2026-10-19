// The cross-org suite (ADR 0044, #250): three orgs (two made through the management API and `global`) use the same names
// everywhere (credential, key, session and model names), and every store of org data is written by one org and read by
// the others: KV, the signature and Antigravity state, the per-isolate caches, SessionState, the D1 usage records
// through every query the management API exposes, the ControlPlane addressed by key prefix and by slug, and Tools'
// toolkits by name and by id.
// Each store is one `storeCase` in `STORES`: a new store (tool calls, approvals, runs, sandbox and browser sessions,
// profiles) adds one line there (docs/DEVELOPMENT.md, "Tests").
import { env } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuthDirectory,
  forgetStanding,
  parseApiKey,
  requireStanding,
  resetApiKeyCaches,
  verifyApiKey,
} from "@commissary/auth";
import { CurrentOrg, GLOBAL_ORG, OrgId, orgKv } from "@commissary/core";
import { controlPlaneOf, resolveBackend, stateAuthDirectory } from "@commissary/state";
import {
  antigravityModelsName,
  antigravityStateFor,
  authIndexOf,
  ConfigReader,
  insertUsageRecord,
  listUsageRecords,
  loadAntigravityHints,
  loadVideoBinding,
  makeKvSignatureStore,
  makeMemoryAntigravityState,
  ModelRegistry,
  ModelRegistryLive,
  orgAuthIndexer,
  orgSignatureCache,
  resetUsageDb,
  sampleRecord,
  saveVideoBinding,
  summarizeUsage,
} from "@commissary/models/testing";
import { type EnvServices, envContext } from "../src/worker-env.ts";
import {
  ADMIN,
  claudeFile,
  isolatedPlatform,
  jsonInit,
  makeHarness,
  token,
} from "./support/management.ts";
import {
  expectIsolated,
  type IsolationOrg,
  type StoreCase,
  storeCase,
} from "./support/org-isolation.ts";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

/** The org `global` as the isolated Platform registry names it. */
const GLOBAL: IsolationOrg = { id: GLOBAL_ORG, slug: "default" };

const newOrg = async (prefix: string): Promise<IsolationOrg> => {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: `Org ${slug}` }),
  );

  expect(created.status).toBe(201);

  return { id: OrgId.make((created.body as { id: string }).id), slug };
};

let orgs: ReadonlyArray<IsolationOrg> = [];

/** The same person, a plain member of each org: their member id there, by org slug. */
const MEMBER_EMAIL = "iso-member@example.com";

const memberIds = new Map<string, string>();

beforeAll(async () => {
  await resetUsageDb();
  orgs = [await newOrg("iso-a"), await newOrg("iso-b"), GLOBAL];

  for (const org of orgs) {
    const added = await managed(
      org,
      "/members",
      jsonInit("POST", { email: MEMBER_EMAIL, role: "member" }),
    );

    expect(added.status).toBe(201);
    memberIds.set(org.slug, (added.body as { id: string }).id);
  }
});

/** `effect` as a request of `org`: its bindings and its org. */
const reader = ManagedRuntime.make(ConfigReader.layerControlPlane());

const registries = ManagedRuntime.make(ModelRegistryLive);

afterAll(async () => {
  await reader.dispose();
  await registries.dispose();
});

const inOrg = <A, E>(
  org: IsolationOrg,
  effect: Effect.Effect<A, E, EnvServices | CurrentOrg | ConfigReader>,
) =>
  reader.runPromise(
    effect.pipe(Effect.provideContext(envContext(env)), Effect.provideService(CurrentOrg, org.id)),
  );

/** `effect` as a request of `org`, with the model registry's own services. */
const inOrgWithRegistry = <A, E>(
  org: IsolationOrg,
  effect: Effect.Effect<A, E, EnvServices | CurrentOrg | ModelRegistry>,
) =>
  registries.runPromise(
    effect.pipe(Effect.provideContext(envContext(env)), Effect.provideService(CurrentOrg, org.id)),
  );

/** The directory the gates read: the ControlPlanes and the isolated Platform registry. */
const directory = stateAuthDirectory({
  CONTROL_PLANE: env.CONTROL_PLANE,
  PLATFORM: registry.bindings.PLATFORM,
});

/** `path` of `org` in the management API, as the platform admin the org's slug is addressed by. */
const managed = async (org: IsolationOrg, path: string, init: RequestInit = {}) =>
  await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    ...init,
    auth: await token(ADMIN),
  });

const CREDITS = {
  creditAmount: 1,
  minCreditAmount: 0,
  updatedAt: 1,
} as const;

// --- usage ------------------------------------------------------------------------------------------------------------

/** The member id both orgs give the private records the query-level cases write: the same name in each. */
const SHARED_MEMBER = "member-shared";

/**
 * Writes `value` records of the model, credential and member `name`, all of them unpriced; the number of records an org
 * sees is the value it reads back. Request ids are unique (they are never names).
 */
const writeUsage =
  (isPrivate: boolean, memberOf: (org: IsolationOrg) => string = () => SHARED_MEMBER) =>
  async (org: IsolationOrg, name: string, value: string) => {
    for (let i = 0; i < Number(value); i += 1)
      await insertUsageRecord(
        env.USAGE,
        sampleRecord({
          requestId: crypto.randomUUID(),
          orgId: org.id,
          model: name,
          authId: name,
          requestedAt: Date.now() - 60_000 - i,
          memberId: memberOf(org),
          private: isPrivate,
          cost: { micros: 0, unpriced: true },
        }),
      );
  };

const count = (found: number): string | undefined => (found === 0 ? undefined : String(found));

const USAGE = "/observability/usage";

const usage = async (org: IsolationOrg, path: string) =>
  (await managed(org, `${USAGE}${path}`)).body;

const usageValue = (index: number) => String(index);

// --- toolkits ----------------------------------------------------------------------------------------------------------

/** A toolkit's name from the suite's `name` (a toolkit's name holds no `-`). */
const toolkitName = (name: string): string => name.replaceAll("-", "_");

/** A toolkit's source that carries the org's value in its host; no list is built, as no credential is connected. */
const toolkitSource = (value: string): string => `https://${value}.iso-tools.example.com/mcp`;

const valueOfSource = (source: string | undefined): string | undefined =>
  source === undefined ? undefined : new URL(source).hostname.split(".")[0];

/** The toolkits the by-id case added, by the suite's name: their ids and the value of their org. */
const toolkitIds = new Map<
  string,
  ReadonlyArray<{ readonly id: string; readonly value: string }>
>();

// --- the stores ---------------------------------------------------------------------------------------------------------

/** Every store of org data; adding a store is adding a line. */
const STORES: ReadonlyArray<StoreCase> = [
  // KV through `OrgKv`.
  storeCase("kv: OrgKv", {
    write: async (org, name, value) => await orgKv(env.CACHE, org.id).put(name, value),
    read: async (org, name) => (await orgKv(env.CACHE, org.id).get(name)) ?? undefined,
  }),
  storeCase("kv: signature store", {
    write: async (org, name, value) =>
      await makeKvSignatureStore(orgKv(env.CACHE, org.id)).put({
        modelName: "claude-sonnet-4-5",
        text: name,
        signature: value,
      }),
    read: async (org, name) =>
      await makeKvSignatureStore(orgKv(env.CACHE, org.id)).get("claude-sonnet-4-5", name),
  }),
  storeCase("kv: xAI video bindings", {
    write: async (org, name, value) =>
      await inOrg(org, saveVideoBinding(name, { authId: value, model: "grok" }, 60_000)),
    read: async (org, name) => (await inOrg(org, loadVideoBinding(name)))?.authId,
  }),
  storeCase("kv: Antigravity credits", {
    write: async (org, name, value) =>
      await antigravityStateFor(env, org.id).setCredits(name, { ...CREDITS, paidTierId: value }),
    read: async (org, name) => (await antigravityStateFor(env, org.id).credits(name))?.paidTierId,
  }),
  storeCase("kv: Antigravity model entitlements", {
    write: async (org, name, value) =>
      await orgKv(env.CACHE, org.id).put(
        antigravityModelsName(name),
        JSON.stringify({ hints: { modelIds: [value], webSearchModelIds: [] }, fetchedAt: 1 }),
      ),
    read: async (org, name) =>
      (await loadAntigravityHints(orgKv(env.CACHE, org.id), [name])).get(name)?.modelIds?.at(0),
  }),

  // SessionState.
  storeCase("session state", {
    write: async (org, name, value) => {
      const address = { store: "codex-replay", scope: "", session: name };

      await inOrg(
        org,
        Effect.flatMap(resolveBackend(), (backend) =>
          backend.run(address, [{ op: "put", key: "k", value, ttlMs: 60_000 }]),
        ),
      );
    },
    read: async (org, name) => {
      const address = { store: "codex-replay", scope: "", session: name };

      const [result] = await inOrg(
        org,
        Effect.flatMap(resolveBackend(), (backend) =>
          backend.run(address, [{ op: "get", key: "k" }]),
        ),
      );

      return result?.status === "ok" ? result.value : undefined;
    },
  }),

  // Worker caches: the per-isolate ones that hold org data.
  storeCase("worker cache: signatures", {
    write: async (org, name, value) => {
      expect(orgSignatureCache(org.id).set("claude-sonnet-4-5", name, value)).toBe(true);
    },
    // A signature is at least 50 characters.
    value: (index) => `${"signature".repeat(6)}-${index}`,
    read: async (org, name) => {
      const found = orgSignatureCache(org.id).get("claude-sonnet-4-5", name);

      return found === "" ? undefined : found;
    },
  }),
  storeCase("worker cache: Antigravity state", {
    write: async (org, name, value) =>
      await makeMemoryAntigravityState(org.id).setCredits(name, { ...CREDITS, paidTierId: value }),
    read: async (org, name) => (await makeMemoryAntigravityState(org.id).credits(name))?.paidTierId,
  }),
  storeCase("worker cache: config snapshots", {
    write: async (org, _name, value) => {
      const imported = await controlPlaneOf(env, org.id)
        .models()
        .importConfig(
          `claude-api-key:\n  - api-key: sk-${value}\n    base-url: https://${value}.example\n`,
          "test",
        );

      expect(imported.ok).toBe(true);
      // The write path of the Worker drops the org's snapshot; another org's stays.
      await inOrg(
        org,
        ConfigReader.use((reader) => reader.invalidate),
      );
    },
    read: async (org, _name) =>
      await inOrg(
        org,
        ConfigReader.use((reader) => reader.get).pipe(
          Effect.map((snapshot) => {
            const url = snapshot.config["api-keys"].claude[0]?.["base-url"];

            return url?.replace(/^https:\/\/|\.example$/g, "");
          }),
          Effect.orElseSucceed(() => undefined),
        ),
      ),
    value: (index) => `config-${index}`,
  }),

  // The model registry's per-org snapshots: the same model name served by a provider named for the org's value.
  storeCase("worker cache: registry snapshots", {
    write: async (org, name, value) => {
      const imported = await controlPlaneOf(env, org.id)
        .models()
        .importConfig(
          [
            "openai-compatibility:",
            `  - name: ${value}`,
            "    base-url: https://upstream.example/v1",
            `    models: [{ name: upstream-model, alias: ${name} }]`,
            "    keys: [{ api-key: sk-test }]",
            "",
          ].join("\n"),
          "test",
        );

      expect(imported.ok).toBe(true);
      // An edit through the management API rebuilds the org's snapshot; another org's stays.
      await inOrgWithRegistry(
        org,
        ModelRegistry.use((models) => models.fresh),
      );
    },
    read: async (org, name) =>
      await inOrgWithRegistry(
        org,
        ModelRegistry.use((models) => models.snapshot).pipe(
          Effect.map((snapshot) =>
            snapshot.providersForModel(name)[0]?.replace(/^openai-compatible-/, ""),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      ),
    value: (index) => `registry-${index}`,
  }),

  // The auth Worker's per-isolate standing cache: the first org is suspended and the others are not.
  storeCase("worker cache: standings", {
    write: async (org, name, value) => {
      if (value === "suspended") {
        await registry.platform.setOrgSuspended(org.slug, true, Date.now());
        forgetStanding({ org: org.id });
      }

      // The read warms the cache for each org before its turn (`alwaysAnswers`).
      void name;
    },
    read: async (org, name) =>
      await Effect.runPromise(
        requireStanding(org.id, `${name}@example.com`).pipe(
          Effect.map((standing) => standing.org),
          Effect.catchTag("ForbiddenError", () => Effect.succeed("suspended")),
          Effect.provide(Layer.succeed(AuthDirectory, directory)),
          Effect.orDie,
        ),
      ),
    value: (index) => (index === 1 ? "suspended" : "active"),
    alwaysAnswers: true,
    after: async (all) => {
      for (const org of all) {
        await registry.platform.setOrgSuspended(org.slug, false, Date.now());
        forgetStanding({ org: org.id });
      }
    },
  }),

  // D1 usage: every query the management API exposes, a record count per org (the value is how many records it wrote).
  storeCase("usage: records", {
    write: writeUsage(false),
    read: async (org, name) =>
      count(
        ((await usage(org, `/records?model=${name}&limit=1000`)) as { records: unknown[] }).records
          .length,
      ),
    value: usageValue,
  }),
  storeCase("usage: summary", {
    write: writeUsage(false),
    read: async (org, name) => {
      const summary = (await usage(org, "/summary?group_by=model")) as {
        groups: ReadonlyArray<{ key: string; requests: number }>;
      };

      return count(summary.groups.find((group) => group.key === name)?.requests ?? 0);
    },
    value: usageValue,
  }),
  storeCase("usage: series", {
    write: writeUsage(false),
    read: async (org, name) => {
      const since = Date.now() - 3_600_000;

      const series = (await usage(org, `/series?since=${since}&group_by=model`)) as {
        series: ReadonlyArray<{ key: string; points: ReadonlyArray<{ requests: number }> }>;
      };

      const points = series.series.find((group) => group.key === name)?.points ?? [];

      return count(points.reduce((sum, point) => sum + point.requests, 0));
    },
    value: usageValue,
  }),
  storeCase("usage: unpriced models", {
    write: writeUsage(false),
    read: async (org, name) => {
      const unpriced = (await usage(org, "/unpriced")) as {
        models: ReadonlyArray<{ model: string; requests: number }>;
      };

      return count(unpriced.models.find((model) => model.model === name)?.requests ?? 0);
    },
    value: usageValue,
  }),
  storeCase("usage: export queue", {
    write: writeUsage(false),
    read: async (org, name) =>
      count(
        ((await usage(org, "/queue?count=1000")) as ReadonlyArray<{ model: string }>).filter(
          (record) => record.model === name,
        ).length,
      ),
    value: usageValue,
  }),
  storeCase("usage: private records of the same member id", {
    write: writeUsage(true),
    read: async (org, name) =>
      count(
        (
          await listUsageRecords(
            env.USAGE,
            org.id,
            { model: name, privateOf: SHARED_MEMBER },
            authIndexOf,
          )
        ).rows.length,
      ),
    value: usageValue,
  }),
  storeCase("usage: summary including private records", {
    write: writeUsage(true),
    read: async (org, name) => {
      const summary = await summarizeUsage(
        env.USAGE,
        org.id,
        { groupBy: "model", privateOf: SHARED_MEMBER },
        authIndexOf,
      );

      return count(summary.groups.find((group) => group.key === name)?.requests ?? 0);
    },
    value: usageValue,
  }),
  storeCase("usage: credential filter on the same credential name", {
    write: writeUsage(false),
    read: async (org, name) =>
      count(
        (await listUsageRecords(env.USAGE, org.id, { authIndex: authIndexOf(name) }, authIndexOf))
          .rows.length,
      ),
    value: usageValue,
  }),
  storeCase("usage: credential filter through the management API", {
    write: writeUsage(false),
    read: async (org, name) => {
      const index = orgAuthIndexer(env, org.id)(name);

      return count(
        ((await usage(org, `/records?auth_index=${index}&limit=1000`)) as { records: unknown[] })
          .records.length,
      );
    },
    value: usageValue,
  }),
  storeCase("usage: private records read by their member through the management API", {
    write: writeUsage(true, (org) => memberIds.get(org.slug) ?? ""),
    read: async (org, name) => {
      const records = await harness.json(
        `/v9/management/orgs/${org.slug}${USAGE}/records?model=${name}&limit=1000`,
        { auth: await token(MEMBER_EMAIL) },
      );

      expect(records.status).toBe(200);

      return count((records.body as { records: unknown[] }).records.length);
    },
    value: usageValue,
  }),

  // The ControlPlane, addressed by org slug through the management API.
  storeCase("controlplane: credentials by slug", {
    write: async (org, name, value) => {
      const uploaded = await managed(org, `/credentials?name=${name}.json`, {
        ...jsonInit("POST", claudeFile({ email: `${value}@example.com` })),
      });

      expect(uploaded.status).toBe(200);
    },
    read: async (org, name) => {
      const listed = await managed(org, "/credentials");

      const files = (listed.body as { files: ReadonlyArray<{ name: string; email?: string }> })
        .files;

      return files
        .find((file) => file.name === `${name}.json`)
        ?.email?.replace(/@example\.com$/, "");
    },
  }),

  // Tools' toolkits, in the ControlPlane's Tools part: listed by name, and reached by id.
  storeCase("controlplane: toolkits by name", {
    write: async (org, name, value) => {
      const added = await managed(org, "/toolkits", {
        ...jsonInit("POST", { source: toolkitSource(value), name: toolkitName(name) }),
      });

      expect(added.status).toBe(201);
    },
    read: async (org, name) => {
      const listed = await managed(org, "/toolkits");

      const toolkits = (
        listed.body as { toolkits: ReadonlyArray<{ name: string; source: string }> }
      ).toolkits;

      return valueOfSource(toolkits.find((toolkit) => toolkit.name === toolkitName(name))?.source);
    },
    value: (index) => `org${index}`,
  }),
  storeCase("controlplane: toolkits by id", {
    write: async (org, name, value) => {
      const added = await managed(org, "/toolkits", {
        ...jsonInit("POST", { source: toolkitSource(value), name: toolkitName(name) }),
      });

      expect(added.status).toBe(201);
      toolkitIds.set(name, [
        ...(toolkitIds.get(name) ?? []),
        { id: (added.body as { id: string }).id, value },
      ]);
    },
    // Every id any org's toolkit of `name` has: only the org's own answers.
    read: async (org, name) => {
      for (const written of toolkitIds.get(name) ?? []) {
        const reached = await managed(org, `/toolkits/${written.id}/tools`);

        if (reached.status === 200) return written.value;

        expect(reached.status).toBe(404);
      }

      return undefined;
    },
    value: (index) => `org${index}`,
  }),
];

describe("one name in three orgs, one store at a time", () => {
  for (const store of STORES)
    it(store.store, async () => {
      await expectIsolated(orgs, store);
    });
});

// --- the ControlPlane, addressed by key prefix and by slug -------------------------------------------------------------

describe("the ControlPlane an API key or a slug reaches", () => {
  const member = async (org: IsolationOrg, email: string) => {
    const added = await managed(org, "/members", jsonInit("POST", { email, role: "member" }));

    expect(added.status).toBe(201);

    return (added.body as { id: string }).id;
  };

  it("a key reaches only the org its prefix names, whatever its id and secret", async () => {
    const [a, b] = orgs;

    if (a === undefined || b === undefined) throw new Error("the orgs are not ready");
    // The same person and the same key name in both orgs.
    const email = `shared-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const issued: Array<{ org: IsolationOrg; key: string }> = [];

    for (const org of [a, b]) {
      const memberId = await member(org, email);

      const created = await controlPlaneOf(env, org.id).createApiKey(
        { memberId, name: "laptop" },
        Date.now(),
      );

      if (!created.ok) throw new Error(created.message);
      issued.push({ org, key: created.value.key });
    }

    const verify = async (text: string) =>
      await Effect.runPromise(
        verifyApiKey(text).pipe(
          Effect.provide(Layer.succeed(AuthDirectory, directory)),
          Effect.result,
        ),
      );

    // Real keys first, and they stay cached: the forged ones below are tried against a warm cache.
    resetApiKeyCaches();

    for (const { org, key } of issued) {
      const verified = await verify(key);

      expect(Result.isSuccess(verified) ? verified.success.org : undefined).toBe(org.id);
    }

    // A's key id and secret under B's prefix (and the other way round) reach B's ControlPlane, which has no such key.
    for (const [from, to] of [
      [issued[0], issued[1]],
      [issued[1], issued[0]],
    ] as const) {
      const parsed = parseApiKey(from?.key ?? "");
      const secret = (from?.key ?? "").slice(`cms_${from?.org.id}_${parsed?.keyId}_`.length);

      const forged = `cms_${to?.org.id}_${parsed?.keyId}_${secret}`;

      expect(Result.isFailure(await verify(forged))).toBe(true);
    }

    // The real keys still verify, each as its own org.
    for (const { org, key } of issued) {
      const verified = await verify(key);

      expect(Result.isSuccess(verified) ? verified.success.org : undefined).toBe(org.id);
    }
  });

  it("a slug reaches its own org's ControlPlane, and a member of one org cannot address another's", async () => {
    const [a, b] = orgs;

    if (a === undefined || b === undefined) throw new Error("the orgs are not ready");
    const email = `slug-${crypto.randomUUID().slice(0, 8)}@example.com`;

    await member(a, email);
    // The person belongs to A only; B has the credential name as well.
    const alice = await token(email);

    expect(
      (await managed(a, "/credentials?name=owned.json", jsonInit("POST", claudeFile()))).status,
    ).toBe(200);
    expect(
      (await managed(b, "/credentials?name=owned.json", jsonInit("POST", claudeFile()))).status,
    ).toBe(200);

    const own = await harness.json(`/v9/management/orgs/${a.slug}/credentials`, { auth: alice });
    expect(own.status).toBe(200);

    const other = await harness.json(`/v9/management/orgs/${b.slug}/credentials`, { auth: alice });
    expect([other.status, other.body]).toEqual([403, { error: "Forbidden" }]);
  });

  it("a slug that is renamed and taken again reaches the new org, not the old one's data", async () => {
    const original = await newOrg("iso-renamed");

    expect(
      (await managed(original, "/credentials?name=kept.json", jsonInit("POST", claudeFile())))
        .status,
    ).toBe(200);

    const renamed = `iso-moved-${crypto.randomUUID().slice(0, 8)}`;

    const patched = await harness.json(`/v9/management/orgs/${original.slug}`, {
      ...jsonInit("PATCH", { slug: renamed }),
      auth: await token(ADMIN),
    });

    expect(patched.status).toBe(200);

    // A new org takes the old slug: it starts empty, and the old org's data is under its new slug only.
    const taken = await harness.json("/v9/management/orgs", {
      ...jsonInit("POST", { slug: original.slug, name: "Taker" }),
      auth: await token(ADMIN),
    });

    expect(taken.status).toBe(201);

    const names = async (slug: string) =>
      (
        (await managed({ id: original.id, slug }, "/credentials")).body as {
          files: ReadonlyArray<{ name: string }>;
        }
      ).files.map((file) => file.name);

    expect(await names(original.slug)).toEqual([]);
    expect(await names(renamed)).toEqual(["kept.json"]);
  });
});
