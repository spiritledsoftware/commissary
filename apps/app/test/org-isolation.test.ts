// The cross-org suite (ADR 0044, #250): three orgs (two made through the management API and `global`) use the same names
// everywhere (credential, key, session and model names), and every store of org data is written by one org and read by
// the others: KV, the signature and Antigravity state, the per-isolate caches, SessionState, the D1 usage records
// through every query the management API exposes, the ControlPlane addressed by key prefix and by slug, and Tools'
// toolkits by name and by id, their tool grants, the upstream MCP sessions their calls keep, the pending approvals
// of their calls, Commissary Cloud's OAuth grants for MCP clients, the browser sessions and crawls, the sessions of the
// built-in sandbox toolkit with its network ceiling, the hosted agents, their runs and the runs' own objects, and the
// browser profiles with their grants.
// Each store is one `storeCase` in `STORES`: a new store (tool calls, approvals, runs, profiles) adds one line there
// (docs/DEVELOPMENT.md, "Tests").
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { SandboxNetwork } from "@commissary/contract/tools";
import { Effect, Layer, ManagedRuntime, Result, type Schema } from "effect";
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
import {
  BrowserCrawlStore,
  browserSessionStub,
  type FakeMcpServer,
  fakeMcpServer,
  insertToolCallRecord,
  serveFakeMcpServers,
  signInGrants,
} from "@commissary/tools/testing";
import { agentBody } from "@commissary/agents/testing";

serveFakeMcpServers();

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

/** The fake MCP server of a name: a 2025 server whose one tool, `session`, answers the session it is called in. */
const sessionServers = new Map<string, FakeMcpServer>();

const sessionServer = (name: string): FakeMcpServer => {
  const known = sessionServers.get(name);

  if (known !== undefined) return known;

  const server = fakeMcpServer(`https://${name}.iso-mcp.example.com/mcp`, {
    tools: [{ name: "session" }],
    call: (_tool, _args, request) => ({
      content: [{ type: "text", text: request.headers.get("mcp-session-id") ?? "" }],
    }),
  });

  sessionServers.set(name, server);

  return server;
};

/** The fake MCP server of a name for the approvals case: its one tool, `act`, is never reached (its calls wait). */
const approvalServers = new Map<string, FakeMcpServer>();

const approvalServer = (name: string): FakeMcpServer => {
  const known =
    approvalServers.get(name) ??
    fakeMcpServer(`https://${name}.iso-approvals.example.com/mcp`, {
      tools: [{ name: "act" }],
    });

  approvalServers.set(name, known);

  return known;
};

/** The sign-ins the sign-in case started, by the suite's name: their states and the value of their org. */
const signInStates = new Map<
  string,
  ReadonlyArray<{ readonly state: string; readonly value: string }>
>();

/** An OAuth app of a toolkit whose client id names `value`. */
const oauthApp = (value: string) => ({
  client_id: `client-${value}`,
  authorize_url: `https://${value}.iso-auth.example.com/authorize`,
  token_url: `https://${value}.iso-auth.example.com/token`,
});

/** Adds the org toolkit of the OAuth cases for `name`: its id. */
const oauthToolkit = async (org: IsolationOrg, name: string, value: string): Promise<string> => {
  const added = await managed(org, "/toolkits", {
    ...jsonInit("POST", { source: toolkitSource(value), name: toolkitName(`oauth-${name}`) }),
  });

  expect(added.status).toBe(201);

  return (added.body as { id: string }).id;
};

/** The org's toolkit of the OAuth cases for `name`, as the org's admin lists it. */
const oauthToolkitOf = async (org: IsolationOrg, name: string) =>
  (
    (await managed(org, "/toolkits")).body as {
      toolkits: ReadonlyArray<{
        id: string;
        name: string;
        oauth_app?: { client_id: string };
      }>;
    }
  ).toolkits.find((toolkit) => toolkit.name === toolkitName(`oauth-${name}`));

/** The org's value of each upstream session id the session case opened. */
const sessionValues = new Map<string, string>();

const OUTBOUND = { ownHosts: [], localDevelopment: false };

/** A hosted agent's name for the suite's `name` (agent names take `[a-z0-9_]`). */
const agentName = (name: string) => name.replaceAll("-", "_");

/** The suite's member in `org`, as the Tools part sees them. */
const isoViewer = (org: IsolationOrg) => ({ member: memberIds.get(org.slug), admin: false });

/** The agent runs each case name's writes started, in every org (the agent runs' objects' case). */
const runsByName = new Map<string, string[]>();

const runsOf = (name: string): string[] => {
  const known = runsByName.get(name) ?? [];

  runsByName.set(name, known);

  return known;
};

/** The upstream session a call of the tool of `name` is in, through `org`'s Tools part; none without the toolkit. */
const sessionOf = async (org: IsolationOrg, name: string): Promise<string | undefined> => {
  const called = await env.CONTROL_PLANE.getByName(org.id)
    .tools()
    .callTool(isoViewer(org), { name: `${toolkitName(name)}_session` }, OUTBOUND);

  if (called.outcome === "unknown") return undefined;

  if (called.outcome !== "result") throw new Error(`the call came to ${called.outcome}`);
  // SAFETY: the fake server answers one text content (`sessionServer`).
  const [content] = called.result["content"] as ReadonlyArray<{ text: string }>;

  return content?.text;
};

/** The browser session id the browser session case uses under the suite's `name`, the same in every org. */
const browserSessionIds = new Map<string, string>();

const browserSessionId = (name: string): string => {
  const known = browserSessionIds.get(name) ?? `bs_${crypto.randomUUID().replaceAll("-", "")}`;

  browserSessionIds.set(name, known);

  return known;
};

/** The same member and principal in every org: only the org tells their sessions apart. */
const browserCaller = (org: IsolationOrg) => ({
  org: org.id,
  member: "iso-member",
  principal: "key:iso",
});

/** The sandbox sessions the sandbox case opened, by the suite's name, whichever org opened them. */
const sandboxSessions = new Map<string, ReadonlyArray<string>>();

/** The grant of the sandbox toolkit the sandbox case wrote in each org, to delete once it ran. */
const sandboxGrants = new Map<string, { readonly id: string; readonly revision: number }>();

/** The sandbox toolkit as an org admin of `org` sees it. */
const sandboxToolkitOf = async (org: IsolationOrg) =>
  (
    await env.CONTROL_PLANE.getByName(org.id)
      .tools()
      .listToolkits({ ...isoViewer(org), admin: true })
  ).toolkits.find((toolkit) => toolkit.id === "sandbox");

/** Sets `org`'s sandbox network ceiling, as an org admin. */
const setCeiling = async (org: IsolationOrg, network: SandboxNetwork) =>
  await env.CONTROL_PLANE.getByName(org.id)
    .tools()
    .updateToolkit(
      { ...isoViewer(org), admin: true },
      "sandbox",
      (await sandboxToolkitOf(org))?.revision ?? 1,
      { network },
      "iso",
      OUTBOUND,
    );

/** A sandbox tool's result for the suite's member in `org`; none when the org has no such tool for them. */
const sandboxCall = async (
  org: IsolationOrg,
  name: string,
  args: Record<string, string>,
): Promise<Record<string, unknown> | undefined> => {
  const called = await env.CONTROL_PLANE.getByName(org.id)
    .tools()
    .callTool(isoViewer(org), { name, arguments: args, principalId: "iso" }, OUTBOUND);

  if (called.outcome === "unknown") return undefined;

  if (called.outcome !== "result") throw new Error(`the call came to ${called.outcome}`);

  return called.result;
};

// --- the stores ---------------------------------------------------------------------------------------------------------

/** Commissary Cloud's OAuth grants for MCP clients (#200), on the test Worker's `OAUTH_KV`. */
const oauthGrants = () => {
  if (env.OAUTH_KV === undefined) throw new Error("OAUTH_KV is not bound (vitest.config.ts)");

  return signInGrants({
    issuer: "https://commissary.test",
    resource: "https://commissary.test/mcp",
    kv: env.OAUTH_KV,
  });
};

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

  // The library's KV, under the member in their org (`signInUserId`): `name` is the same member id in every org.
  storeCase("kv: OAuth grants for MCP clients", {
    write: async (org, name, value) => await oauthGrants().write(org.id, name, value),
    read: async (org, name) => (await oauthGrants().keyIds(org.id, name)).at(0),
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

  storeCase("usage: tool calls", {
    // Tools' own writer: the toolkit's id is the suite's name in both orgs.
    write: async (org, name, value) => {
      for (let i = 0; i < Number(value); i += 1)
        await insertToolCallRecord(env.USAGE, {
          requestId: crypto.randomUUID(),
          orgId: org.id,
          principalId: "user:iso@example.com",
          memberId: undefined,
          toolkitId: name,
          toolId: `${name}:search`,
          credential: "shared",
          private: false,
          outcome: "success",
          requestedAt: Date.now() - 60_000 - i,
          latencyMs: 1,
          requestBytes: 2,
          responseBytes: 3,
          costMicros: 0,
          approval: "none",
        });
    },
    read: async (org, name) =>
      count(
        ((await usage(org, `/records?toolkit=${name}&limit=1000`)) as { records: unknown[] })
          .records.length,
      ),
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
  // Tools' tool grants: each org grants a tool of its own toolkit of the same name, and lists its own grant only.
  storeCase("controlplane: tool grants", {
    write: async (org, name, value) => {
      const added = await managed(org, "/toolkits", {
        ...jsonInit("POST", { source: toolkitSource(value), name: toolkitName(`grant-${name}`) }),
      });

      expect(added.status).toBe(201);
      const toolkit = (added.body as { id: string }).id;

      const granted = await managed(org, "/grants/tools", {
        ...jsonInit("POST", {
          subject: { kind: "everyone" },
          toolkit,
          tools: { kind: "named", ids: [`${toolkit}:${value}`] },
        }),
      });

      expect(granted.status).toBe(200);
    },
    read: async (org, name) => {
      const toolkits = (
        (await managed(org, "/toolkits")).body as {
          toolkits: ReadonlyArray<{ id: string; name: string }>;
        }
      ).toolkits;

      const toolkit = toolkits.find((found) => found.name === toolkitName(`grant-${name}`))?.id;

      const grants = (
        (await managed(org, "/grants/tools")).body as {
          grants: ReadonlyArray<{ toolkit: string; tools: { ids?: ReadonlyArray<string> } }>;
        }
      ).grants;

      const [id] = grants.find((grant) => grant.toolkit === toolkit)?.tools.ids ?? [];

      return id?.slice(`${toolkit}:`.length);
    },
    value: (index) => `org${index}`,
  }),
  // The pending approvals of Tools' calls: each org's member calls the same tool, under the same toolkit name, with the
  // org's value as its argument; the call waits for them (the caller is its approver), and each finds its own only.
  storeCase("controlplane: pending approvals", {
    write: async (org, name, value) => {
      const tools = env.CONTROL_PLANE.getByName(org.id).tools();
      const admin = { ...isoViewer(org), admin: true };

      const added = await tools.addToolkit(
        admin,
        {
          source: approvalServer(name).url,
          name: toolkitName(name),
          private: false,
          accepts: "shared",
          credential: { kind: "none", subject: { kind: "everyone" } },
        },
        "iso",
        OUTBOUND,
      );

      if (!added.ok) throw new Error(added.message);

      const ruled = await tools.updateToolkit(
        admin,
        added.value.id,
        added.value.revision,
        { approval_rules: { writes: {} } },
        "iso",
        OUTBOUND,
      );

      if (!ruled.ok) throw new Error(ruled.message);

      const called = await tools.callTool(
        isoViewer(org),
        {
          name: `${toolkitName(name)}_act`,
          arguments: { value },
          principalId: "iso",
          approvalOutcomes: true,
        },
        OUTBOUND,
      );

      if (called.outcome !== "pending") throw new Error(`the call came to ${called.outcome}`);
    },
    read: async (org, name) => {
      const { approvals } = await env.CONTROL_PLANE.getByName(org.id)
        .tools()
        .listApprovals(isoViewer(org));

      const found = approvals.find((approval) => approval.toolkit.name === toolkitName(name));
      const value = found?.arguments?.["value"];

      return typeof value === "string" ? value : undefined;
    },
  }),
  // Tools' OAuth apps (#202): each org sets its own app on its toolkit of the same name, and reads its own back.
  storeCase("controlplane: toolkit OAuth apps", {
    write: async (org, name, value) => {
      const id = await oauthToolkit(org, name, value);

      const set = await managed(org, `/toolkits/${id}/oauth-app`, {
        ...jsonInit("PUT", oauthApp(value)),
      });

      expect(set.status).toBe(200);
    },
    read: async (org, name) =>
      (await oauthToolkitOf(org, name))?.oauth_app?.client_id.replace(/^client-/, ""),
    value: (index) => `org${index}`,
  }),
  // Tools' OAuth sign-ins (#202): a sign-in's state reads only in the org that started it.
  storeCase("controlplane: toolkit sign-ins", {
    write: async (org, name, value) => {
      const id = await oauthToolkit(org, `signin-${name}`, value);

      expect(
        (await managed(org, `/toolkits/${id}/oauth-app`, { ...jsonInit("PUT", oauthApp(value)) }))
          .status,
      ).toBe(200);

      // Started by the org's member, as an org admin: only a member starts (and finishes) a sign-in.
      const started = await env.CONTROL_PLANE.getByName(org.id)
        .tools()
        .startSignIn(
          { ...isoViewer(org), admin: true },
          id,
          "shared",
          { subject: { kind: "everyone" } },
          "iso",
          OUTBOUND,
          { callback: "https://commissary.test/oauth/toolkits/callback", clientId: undefined },
        );

      if (!started.ok) throw new Error(started.message);
      signInStates.set(name, [
        ...(signInStates.get(name) ?? []),
        { state: started.value.state, value },
      ]);
    },
    // Every state any org started for `name`, read at the org's own toolkit: only the org's own answers.
    read: async (org, name) => {
      const id = (await oauthToolkitOf(org, `signin-${name}`))?.id;

      if (id === undefined) return undefined;

      for (const written of signInStates.get(name) ?? []) {
        const status = await managed(org, `/toolkits/${id}/sign-in?state=${written.state}`);

        if (status.status === 200) return written.value;

        expect(status.status).toBe(404);
      }

      return undefined;
    },
    value: (index) => `org${index}`,
  }),
  // The upstream MCP sessions Tools' calls keep: each org's member calls the same server under the same toolkit name,
  // and a later call goes on in its own org's session.
  storeCase("controlplane: upstream MCP sessions", {
    write: async (org, name, value) => {
      const plane = env.CONTROL_PLANE.getByName(org.id);

      await plane.setMembershipSettings({ privateCredentials: true, privateToolkits: true });

      const added = await plane.tools().addToolkit(
        isoViewer(org),
        {
          source: sessionServer(name).url,
          name: toolkitName(name),
          private: true,
          accepts: "private",
          credential: { kind: "none" },
        },
        "iso",
        OUTBOUND,
      );

      if (!added.ok) throw new Error(added.message);
      const session = await sessionOf(org, name);

      if (session === undefined || session === "") throw new Error("the call opened no session");
      sessionValues.set(session, value);
    },
    read: async (org, name) => {
      const session = await sessionOf(org, name);

      return session === undefined ? undefined : sessionValues.get(session);
    },
    after: async (shared) => {
      for (const org of shared)
        await env.CONTROL_PLANE.getByName(org.id).setMembershipSettings({
          privateCredentials: false,
          privateToolkits: false,
        });
    },
  }),
  // The Agents part's hosted agents (#226): each org saves a shared agent of the same name, its value as the agent's
  // description, and lists its own only. Written on the part (the model it names is taken as served, a check of the
  // routes'), read through the management API.
  storeCase("controlplane: agents", {
    write: async (org, name, value) => {
      const created = await env.CONTROL_PLANE.getByName(org.id)
        .agents()
        .createAgent(
          { ...isoViewer(org), admin: true },
          {
            ...agentBody(agentName(name), "shared-model"),
            description: value,
            subject: { kind: "everyone" },
          },
          { modelServed: true },
          "iso",
        );

      expect(created.ok).toBe(true);
    },
    read: async (org, name) => {
      const listed = await managed(org, "/agents");

      expect(listed.status).toBe(200);

      const agents = (
        listed.body as { agents: ReadonlyArray<{ name: string; description: string }> }
      ).agents;

      return agents.find((agent) => agent.name === agentName(name))?.description;
    },
  }),
  // The org's index of agent runs (#227), in its ControlPlane: each org's member starts a run, with the same idempotency
  // key, of a shared agent named after the org's value; each lists its own run only. Written and read on the part (the
  // run's object, named by its org and id, is the management routes' to start: `agent-runs.test.ts`).
  storeCase("controlplane: agent runs", {
    value: (index) => `run_value_${index}`,
    write: async (org, name, value) => {
      const agents = env.CONTROL_PLANE.getByName(org.id).agents();

      const created = await agents.createAgent(
        { ...isoViewer(org), admin: true },
        { ...agentBody(value, "shared-model"), subject: { kind: "everyone" } },
        { modelServed: true },
        "iso",
      );

      if (!created.ok) throw new Error(created.message);
      const started = await agents.startRun(isoViewer(org), created.value.id, "chat", name);

      expect(started.ok).toBe(true);
    },
    read: async (org) =>
      (await env.CONTROL_PLANE.getByName(org.id).agents().listRuns(isoViewer(org))).runs.find(
        (run) => run.agent.name?.startsWith("run_value_") === true,
      )?.agent.name,
  }),
  // The agent runs' own objects (#227), named by org and run, which hold each run's transcript and turns: each org's
  // member starts a run whose first input is the org's value; each org's objects show its own run's input, and the
  // runs the other orgs started find nothing under this org's name.
  storeCase("agent runs' objects", {
    value: (index) => `run_input_${index}`,
    write: async (org, name, value) => {
      const agents = env.CONTROL_PLANE.getByName(org.id).agents();

      const created = await agents.createAgent(
        { ...isoViewer(org), admin: true },
        {
          ...agentBody(`obj_${name.replaceAll("-", "_")}`, "shared-model"),
          subject: { kind: "everyone" },
        },
        { modelServed: true },
        "iso",
      );

      if (!created.ok) throw new Error(created.message);
      const started = await agents.startRun(isoViewer(org), created.value.id, "chat", name);

      if (!started.ok) throw new Error(started.message);
      runsOf(name).push(started.value.run.id);

      const first = await env.AGENT_RUN.getByName(`${org.id}:${started.value.run.id}`).start(
        { org: org.id, id: started.value.run.id },
        value,
      );

      expect(first.ok).toBe(true);
    },
    read: async (org, name) => {
      for (const run of runsOf(name)) {
        const shown = await env.AGENT_RUN.getByName(`${org.id}:${run}`).show();

        if (shown.ok) return shown.value.turns[0]?.input;
      }

      return undefined;
    },
  }),
  // The browser toolkit's sessions (#213): each org opens a session of the same id, as the same member and API key, at
  // a page that carries its value; each reaches its own session's page, and an org that opened none finds it unknown.
  // `browser_open` through the part gives each session a random id, and the suite needs one id in every org: so it
  // opens and reaches them on their objects, by the org-scoped name the part reaches them by (`browserSessionStub`).
  storeCase("browser sessions", {
    write: async (org, name, value) => {
      const id = browserSessionId(name);

      // SAFETY: a call without metering (as a Tools part from before #214 makes) answers the bare tool result.
      const opened = (await browserSessionStub(env.BROWSER_SESSIONS, org.id, id).open(
        browserCaller(org),
        id,
        "browser-run",
        `https://${value}.iso-browser.example.com/`,
      )) as Schema.JsonObject;

      if (opened["isError"] === true) throw new Error(JSON.stringify(opened));
    },
    read: async (org, name) => {
      const id = browserSessionId(name);

      // SAFETY: as above, the bare tool result.
      const listed = (await browserSessionStub(env.BROWSER_SESSIONS, org.id, id).operate(
        browserCaller(org),
        id,
        { tool: "tab_list", args: { sessionId: id } },
      )) as Schema.JsonObject;

      if (listed["isError"] === true) return undefined;
      // SAFETY: a session's tab list is one text content.
      const [content] = listed["content"] as ReadonlyArray<{ readonly text: string }>;

      return /https:\/\/([a-z0-9]+)\.iso-browser\.example\.com/.exec(content?.text ?? "")?.[1];
    },
    value: (index) => `org${index}`,
  }),
  // The browser toolkit's profiles (#215) and the grants on shared ones: each org's admin creates a shared profile under
  // the same name, which carries the org's value (`<name>-<value>`), and grants it to everyone; each finds only its own
  // profile, granted in its own grants (a profile opens only in its own org: the Tools part resolves `browser_open`'s
  // profile among its org's, test/browser-profiles.test.ts of `@commissary/tools`).
  storeCase("controlplane: browser profiles", {
    write: async (org, name, value) => {
      const created = await managed(org, "/browser-profiles", {
        ...jsonInit("POST", { name: `${name}-${value}` }),
      });

      expect(created.status).toBe(201);

      const granted = await managed(org, "/grants/profiles", {
        ...jsonInit("POST", {
          subject: { kind: "everyone" },
          profile: (created.body as { id: string }).id,
        }),
      });

      expect(granted.status).toBe(200);
    },
    read: async (org, name) => {
      const profiles = (
        (await managed(org, "/browser-profiles")).body as {
          profiles: ReadonlyArray<{ id: string; name: string }>;
        }
      ).profiles;

      const profile = profiles.find((found) => found.name.startsWith(`${name}-`));

      const grants = (
        (await managed(org, "/grants/profiles")).body as {
          grants: ReadonlyArray<{ profile: string }>;
        }
      ).grants;

      return profile !== undefined && grants.some((grant) => grant.profile === profile.id)
        ? profile.name.slice(`${name}-`.length)
        : undefined;
    },
    value: (index) => `org${index}`,
  }),
  // The browser toolkit's crawls (#270): each org logs a crawl of the same id, started by the same member through an API
  // key named after its value, and each finds only its own starter. The tests' ControlPlane has no Browser Run, so no
  // crawl tools: the case logs and reads the crawls in each org's ControlPlane as the Tools part does.
  storeCase("controlplane: browser crawls", {
    write: async (org, name, value) => {
      await runInDurableObject(env.CONTROL_PLANE.getByName(org.id), (_instance, state) => {
        new BrowserCrawlStore(state.storage.sql).started({
          id: name,
          toolkitId: "browser",
          member: "iso-member",
          principal: `key:${value}`,
          startedAt: Date.now(),
        });
      });
    },
    read: async (org, name) =>
      await runInDurableObject(env.CONTROL_PLANE.getByName(org.id), (_instance, state) => {
        const crawls = new BrowserCrawlStore(state.storage.sql);

        return ["org1", "org2", "org3"].find((value) =>
          crawls.owns(name, { member: "iso-member", principal: `key:${value}` }),
        );
      }),
    value: (index) => `org${index}`,
  }),
  // The sandbox toolkit's network ceiling (#222): each org's admin allows one host of its own, and each finds only its own.
  storeCase("controlplane: sandbox network ceiling", {
    write: async (org, _name, value) => {
      const updated = await setCeiling(org, { kind: "hosts", hosts: [`${value}.example.com`] });

      if (!updated.ok) throw new Error(updated.message);
    },
    read: async (org) => {
      const network = (await sandboxToolkitOf(org))?.network;

      return network?.kind === "hosts" ? network.hosts[0]?.split(".")[0] : undefined;
    },
    value: (index) => `org${index}`,
    after: async (shared) => {
      for (const org of shared) await setCeiling(org, { kind: "none" });
    },
  }),
  // The sessions of the built-in sandbox toolkit (#222): each org's member opens one and writes the org's value to the
  // same file; every org then reads that file in every session opened under the name, and gets into its own only.
  storeCase("controlplane: sandbox sessions", {
    write: async (org, name, value) => {
      const tools = env.CONTROL_PLANE.getByName(org.id).tools();

      const granted = await tools.writeGrant(
        {
          revision: 0,
          value: { subject: { kind: "everyone" }, toolkit: "sandbox", tools: { kind: "all" } },
        },
        "iso",
      );

      if (!granted.ok) throw new Error(granted.message);
      sandboxGrants.set(org.id, granted.value);

      const opened = await sandboxCall(org, "sandbox_open", {});
      // SAFETY: `sandbox_open` answers the session id in its structured content.
      const session = (opened?.["structuredContent"] as { session: string } | undefined)?.session;

      if (session === undefined) throw new Error("the call opened no session");
      sandboxSessions.set(name, [...(sandboxSessions.get(name) ?? []), session]);
      await sandboxCall(org, "sandbox_write", { session, path: "value.txt", content: value });
    },
    read: async (org, name) => {
      for (const session of sandboxSessions.get(name) ?? []) {
        const read = await sandboxCall(org, "sandbox_read", { session, path: "value.txt" });

        if (read !== undefined && read["isError"] !== true) {
          // SAFETY: a sandbox tool answers one text content (`text` in `src/sandbox/toolkit.ts`).
          const [content] = read["content"] as ReadonlyArray<{ text: string }>;

          return content?.text;
        }
      }

      return undefined;
    },
    after: async (shared) => {
      for (const org of shared) {
        const grant = sandboxGrants.get(org.id);

        if (grant !== undefined)
          await env.CONTROL_PLANE.getByName(org.id)
            .tools()
            .writeGrant({ id: grant.id, revision: grant.revision, value: null }, "iso");
      }
    },
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
