// Deleting an org (ADR 0027): an org that is deleted leaves nothing behind, and nothing of any other org is touched.
// Through the management API with the real ControlPlanes, D1, KV, SessionState and a Platform registry of its own.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteOrg, DELETION_BUDGET } from "../src/platform/org-deletion.ts";
import { type OrgDeletionStep, orgScopedName, OrgId } from "@commissary/core";
import { addressName } from "@commissary/state";
import {
  ADMIN,
  claudeFile,
  SERVICE_ADMIN,
  SERVICE_ADMIN_BINDINGS,
  serviceToken,
  isolatedPlatform,
  jsonInit,
  makeHarness,
  token,
} from "./support/management.ts";
import { Effect } from "effect";
import { type ModelsBindings, ModelsEnv } from "@commissary/models/api";
import { orgDeletionStep } from "@commissary/models/management";
import { insertUsageRecord, resetUsageDb, sampleRecord } from "@commissary/models/testing";
import { fakeMcpServer, serveFakeMcpServers } from "@commissary/tools/testing";

// Toolkits' lists are built from a fake MCP server.
serveFakeMcpServers();

const MCP_SERVER = fakeMcpServer("https://mcp.deletion.example.com/mcp", {
  tools: [{ name: "search" }],
});

/** Models' org-deletion step over `bindings`. */
const modelsStep = (bindings: ModelsBindings) =>
  Effect.runPromise(Effect.provideService(orgDeletionStep, ModelsEnv, bindings));

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

beforeAll(async () => {
  await resetUsageDb();
});

type Payload = Parameters<typeof jsonInit>[1];

const send = async (slug: string, path: string, auth: string, method = "GET", body?: Payload) =>
  await harness.json(`/v9/management/orgs/${slug}${path}`, {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    auth,
  });

interface Org {
  readonly slug: string;
  readonly name: string;
  readonly id: OrgId;
  readonly platform: string;
  readonly owner: string;
  readonly admin: string;
  readonly alice: { readonly id: string; readonly auth: string };
}

/** An org with an owner, an admin and a plain member, holding data in every place an org keeps any. */
const newOrg = async (): Promise<Org> => {
  const slug = `del-${crypto.randomUUID().slice(0, 8)}`;
  const name = `Org ${slug}`;
  const platform = await token(ADMIN);

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name, private_credentials: true }),
  );

  expect(created.status).toBe(201);

  const person = async (who: string, role: string) => {
    const email = `${who}-${slug}@example.com`;
    const added = await send(slug, "/members", platform, "POST", { email, role });

    expect(added.status).toBe(201);

    return { id: (added.body as { id: string }).id, auth: await token(email) };
  };

  const org: Org = {
    slug,
    name,
    id: OrgId.make((created.body as { id: string }).id),
    platform,
    owner: (await person("owner", "owner")).auth,
    admin: (await person("admin", "admin")).auth,
    alice: await person("alice", "member"),
  };

  expect(
    (await send(slug, "/credentials?name=shared.json", platform, "POST", claudeFile())).status,
  ).toBe(200);
  expect((await send(slug, "/api-keys", org.alice.auth, "POST", { name: "laptop" })).status).toBe(
    201,
  );

  const group = await send(slug, "/provider-keys/groups", org.alice.auth, "PUT", {
    family: "claude",
    revision: 0,
    group: { "base-url": "https://api.example.test/v1", keys: [{ "api-key": "sk-alice-0001" }] },
  });

  expect(group.status).toBe(200);

  // Toolkits: an org toolkit with its shared credential, tool list and an override, and Alice's private toolkit.
  const toolkit = await send(slug, "/toolkits", platform, "POST", {
    source: MCP_SERVER.url,
    name: "search",
    credential: { kind: "bearer", token: "mcp-token" },
  });

  expect(toolkit.status).toBe(201);
  expect(
    (
      await harness.json(
        `/v9/management/orgs/${slug}/toolkits/${(toolkit.body as { id: string }).id}/overrides`,
        {
          ...jsonInit("PUT", { tool: "search", hidden: true }),
          headers: { "content-type": "application/json", "if-match": "0" },
          auth: platform,
        },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await send(slug, "/toolkits", org.alice.auth, "POST", {
        source: MCP_SERVER.url,
        name: "mine",
        credential: { kind: "none" },
      })
    ).status,
  ).toBe(201);

  await insertUsageRecord(env.USAGE, sampleRecord({ orgId: org.id, requestId: `u1-${slug}` }));
  await insertUsageRecord(env.USAGE, sampleRecord({ orgId: org.id, requestId: `u2-${slug}` }));
  await env.CACHE.put(orgScopedName(org.id, "video:abc"), "1");
  await env.CACHE.put(orgScopedName(org.id, "sig:def"), "1");
  await writeSession(org);

  return org;
};

const sessionName = (org: Org) =>
  addressName({ store: orgScopedName(org.id, "replay"), scope: "s", session: "1" });

const writeSession = async (org: Org) => {
  await env.SESSION_STATE.getByName(sessionName(org)).run([
    { op: "put", key: "k", value: "v", ttlMs: 3_600_000 },
  ]);
};

const sessionValue = async (org: Org) =>
  (await env.SESSION_STATE.getByName(sessionName(org)).run([{ op: "get", key: "k" }]))[0];

const usageRows = async (org: Org) =>
  (
    await env.USAGE.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE org_id = ?")
      .bind(org.id)
      .first<{ n: number }>()
  )?.n;

const kvKeys = async (org: Org) =>
  (await env.CACHE.list({ prefix: `org.${org.id}.` })).keys.map((key) => key.name);

/** The rows every table of the org's ControlPlane holds, by table name (tables that hold none are left out). */
const storedRows = async (org: Org) =>
  await runInDurableObject(env.CONTROL_PLANE.getByName(org.id), (_instance, state) => {
    const sql = state.storage.sql;

    const tables = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",
      )
      .toArray();

    return Object.fromEntries(
      tables
        .map(({ name }) => [
          name,
          sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`).one().n,
        ])
        .filter(([, count]) => count !== 0),
    );
  });

const remove = (org: Org, who: string, name: string = org.name) =>
  send(org.slug, "/org", who, "DELETE", { name });

describe("deleting an org", () => {
  it("removes its usage, session state, cache keys, ControlPlane storage and registry entry", async () => {
    const org = await newOrg();

    expect(await usageRows(org)).toBe(2);
    expect(await kvKeys(org)).toHaveLength(2);
    expect(await sessionValue(org)).toMatchObject({ status: "ok", value: "v" });
    expect(Object.keys(await storedRows(org))).toEqual(
      expect.arrayContaining([
        "credentials",
        "api_keys",
        "private_key_groups",
        "session_instances",
        "toolkits",
        "toolkit_credentials",
        "toolkit_tools",
        "tool_overrides",
      ]),
    );

    const reply = await remove(org, org.platform);

    expect(reply).toMatchObject({
      status: 200,
      body: { deleted: true, id: org.id, slug: org.slug },
    });

    expect(await usageRows(org)).toBe(0);
    expect(await kvKeys(org)).toEqual([]);
    expect(await sessionValue(org)).toMatchObject({ status: "ok", generation: 0 });
    expect(await storedRows(org)).toEqual({});
    expect(await registry.platform.getOrgById(org.id)).toBeUndefined();
    expect(await registry.platform.getOrgBySlug(org.slug)).toBeUndefined();
    expect(await registry.platform.orgsOfEmail(`alice-${org.slug}@example.com`)).toEqual([]);

    // Its address is gone.
    expect((await send(org.slug, "/settings", org.platform)).status).toBe(404);
  });

  it("leaves every other org's data alone and frees the slug for a new, empty org", async () => {
    const doomed = await newOrg();
    const kept = await newOrg();

    expect((await remove(doomed, doomed.platform)).status).toBe(200);

    expect(await usageRows(kept)).toBe(2);
    expect(await kvKeys(kept)).toHaveLength(2);
    expect(await sessionValue(kept)).toMatchObject({ status: "ok", value: "v" });
    expect(await registry.platform.getOrgById(kept.id)).toBeDefined();
    expect((await storedRows(kept))["api_keys"]).toBe(1);
    expect((await send(kept.slug, "/credentials", kept.platform)).body).toMatchObject({
      files: [{ name: "shared.json" }],
    });

    const again = await harness.json(
      "/v9/management/orgs",
      jsonInit("POST", { slug: doomed.slug, name: "Reborn" }),
    );

    expect(again.status).toBe(201);
    expect((again.body as { id: string }).id).not.toBe(doomed.id);
    expect((await send(doomed.slug, "/credentials", doomed.platform)).body).toMatchObject({
      files: [],
    });
    expect(await usageRows(doomed)).toBe(0);
  });

  it("asks for the org's name, and refuses a different one without deleting anything", async () => {
    const org = await newOrg();

    expect(await remove(org, org.platform, "something else")).toMatchObject({
      status: 422,
      body: { error: "name_mismatch" },
    });
    expect((await send(org.slug, "/org", org.platform, "DELETE", {})).status).toBe(400);
    expect((await send(org.slug, "/org", org.platform, "DELETE", { name: 5 })).status).toBe(400);
    expect(await usageRows(org)).toBe(2);
    expect(await registry.platform.getOrgById(org.id)).toBeDefined();
  });

  it("never deletes the first org, whoever asks", async () => {
    const reply = await harness.json("/v9/management/org", jsonInit("DELETE", { name: "Default" }));

    expect(reply).toMatchObject({ status: 409, body: { error: "global_org" } });
    expect((await registry.platform.getOrgById("global"))?.slug).toBe("default");
  });

  it("is for an org owner or a platform admin: an org admin and a member are refused", async () => {
    const org = await newOrg();

    expect(await remove(org, org.admin)).toMatchObject({
      status: 403,
      body: { error: "owner_required" },
    });
    expect((await remove(org, org.alice.auth)).status).toBe(403);
    expect(await registry.platform.getOrgById(org.id)).toBeDefined();

    expect((await remove(org, org.owner)).status).toBe(200);
    expect(await registry.platform.getOrgById(org.id)).toBeUndefined();
  });

  it("is for a person: a service token is refused, an owner service token and a platform admin one too", async () => {
    const org = await newOrg();
    const robot = "robot-owner.access";

    expect(
      (
        await send(org.slug, "/service-tokens", org.platform, "POST", {
          client_id: robot,
          role: "owner",
        })
      ).status,
    ).toBe(201);

    const refused = await remove(org, await serviceToken(robot));

    expect(refused).toMatchObject({ status: 403, body: { error: "person_required" } });

    // A service token that is a platform admin is a machine too.
    const machines = makeHarness(undefined, {
      ...registry.bindings,
      ...SERVICE_ADMIN_BINDINGS,
    });

    try {
      const reply = await machines.json(`/v9/management/orgs/${org.slug}/org`, {
        ...jsonInit("DELETE", { name: org.name }),
        auth: await serviceToken(SERVICE_ADMIN),
      });

      expect(reply).toMatchObject({ status: 403, body: { error: "person_required" } });
    } finally {
      await machines.dispose();
    }

    expect(await registry.platform.getOrgById(org.id)).toBeDefined();
  });

  it("is refused to a member of another org", async () => {
    const mine = await newOrg();
    const theirs = await newOrg();

    expect((await remove(theirs, mine.owner)).status).toBe(403);
    expect(await registry.platform.getOrgById(theirs.id)).toBeDefined();
  });
});

describe("a deletion that needs more than one call", () => {
  it("stops within its budget, keeps the org listed and finishes when it is run again", async () => {
    const org = await newOrg();

    // Too small a budget for one page of cache keys.
    const bindings = { ...env, PLATFORM: registry.bindings.PLATFORM };

    const first = await deleteOrg(bindings, [await modelsStep(bindings)], org.id, {
      now: Date.now(),
      budget: 5,
    });

    expect(first).toEqual({ state: "incomplete", step: "cache" });
    expect(await usageRows(org)).toBe(0);
    expect(await sessionValue(org)).toMatchObject({ status: "ok", value: "v" });
    expect(await registry.platform.getOrgById(org.id)).toBeDefined();

    const second = await deleteOrg(bindings, [await modelsStep(bindings)], org.id, {
      now: Date.now(),
      budget: DELETION_BUDGET,
    });

    expect(second).toEqual({ state: "deleted" });
    expect(await kvKeys(org)).toEqual([]);
    expect(await registry.platform.getOrgById(org.id)).toBeUndefined();
  });

  it("can be repeated after it finished", async () => {
    const org = await newOrg();
    const bindings = { ...env, PLATFORM: registry.bindings.PLATFORM };

    expect(
      await deleteOrg(bindings, [await modelsStep(bindings)], org.id, { now: Date.now() }),
    ).toEqual({
      state: "deleted",
    });
    expect(
      await deleteOrg(bindings, [await modelsStep(bindings)], org.id, { now: Date.now() }),
    ).toEqual({
      state: "deleted",
    });
  });

  it("runs the area steps first, in order, on the budget left, and stops at one that is not complete", async () => {
    const org = await newOrg();
    const bindings = { ...env, PLATFORM: registry.bindings.PLATFORM };
    const seen: Array<readonly [string, number]> = [];

    const step =
      (name: string, calls: number, complete: boolean): OrgDeletionStep =>
      async (id, budget) => {
        seen.push([`${name}:${id === org.id ? "org" : id}`, budget]);

        return complete ? { complete, calls } : { complete, calls, part: name };
      };

    const steps = [step("first", 10, true), step("second", 5, false), step("third", 1, true)];

    expect(await deleteOrg(bindings, steps, org.id, { now: Date.now(), budget: 100 })).toEqual({
      state: "incomplete",
      step: "second",
    });
    expect(seen).toEqual([
      ["first:org", 100],
      ["second:org", 90],
    ]);
    // Nothing after the area steps ran: the session state, the ControlPlane and the registry entry are kept.
    expect(await sessionValue(org)).toMatchObject({ status: "ok", value: "v" });
    expect((await storedRows(org))["api_keys"]).toBe(1);
    expect(await registry.platform.getOrgById(org.id)).toBeDefined();
  });
});
