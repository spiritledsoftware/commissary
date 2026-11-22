// The hub API's ControlPlane methods (ADR 0052): which accounts a management key acting as its issuer lists and
// resolves (auth files of the four providers it reads, enabled, managed in full by the viewer), the token target of a
// relayed call (refreshed first), and the cooldown reset. Upstream token endpoints are mocked by replacing `fetch`
// (the Durable Object runs in the test isolate).
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Viewer } from "@commissary/auth";
import { OrgId } from "@commissary/core";
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { claudeFile, controlPlane } from "./support/control-plane.ts";

const alice: Viewer = { member: "mem-alice", admin: false };

const bob: Viewer = { member: "mem-bob", admin: false };

const admin: Viewer = { member: "mem-admin", admin: true };

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

let currentUpstream: (url: string) => Response = () =>
  new Response("no upstream configured", { status: 500 });

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = async (input: RequestInfo | URL) =>
    currentUpstream(input instanceof Request ? input.url : String(input));
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const codexFile = (extra: Record<string, unknown> = {}) => ({
  type: "codex",
  email: "codex@x.com",
  access_token: "codex-secret-access",
  refresh_token: "codex-secret-refresh",
  account_id: "acct-1",
  expired: "2999-01-01T00:00:00Z",
  ...extra,
});

/** An org of its own with private credentials on, holding the accounts of the visibility rule. */
const seeded = async () => {
  const org = OrgId.make(`hub-${crypto.randomUUID().slice(0, 8)}`);
  const stub = controlPlane(org);

  await stub.setMembershipSettings({ privateCredentials: true });
  const models = stub.models();

  await models.importAuthFile("shared.json", JSON.stringify(claudeFile()), {}, admin);
  await models.importAuthFile("alice.json", JSON.stringify(codexFile()), {}, alice);
  await models.importAuthFile(
    "bob.json",
    JSON.stringify(claudeFile({ email: "bob@x.com" })),
    {},
    bob,
  );

  await models.importAuthFile(
    "off.json",
    JSON.stringify(claudeFile({ email: "off@x.com" })),
    {},
    alice,
  );
  await models.setCredentialDisabled("off.json", true, alice);

  // A provider the hub's readers do not read.
  await models.importAuthFile(
    "kimi.json",
    JSON.stringify({ type: "kimi", access_token: "kimi-secret", expired: "2999-01-01T00:00:00Z" }),
    {},
    alice,
  );

  // A provider key: config keys are never on the hub.
  await models.importConfig("claude-api-key:\n  - api-key: ck-hub-secret\n", "test");

  return { stub, models };
};

/** The `auth_index` of every stored credential, auth files by name and the rest in a list. */
const indexes = async (stub: ReturnType<typeof controlPlane>) => {
  const entries = await stub.models().listCredentialEntries(FULL_ACCESS);
  const byName = new Map<string, string>();

  for (const { name, auth_index: authIndex } of entries)
    if (typeof name === "string" && typeof authIndex === "string") byName.set(name, authIndex);

  const keys = [
    ...JSON.stringify(await stub.models().providerKeysView(FULL_ACCESS)).matchAll(
      /"auth_index":"([0-9a-f]{16})"/g,
    ),
  ].map((match) => match[1] ?? "");

  return { byName, keys };
};

describe("the hub API's accounts", () => {
  it("are the viewer's own and, for an admin, the shared ones: enabled auth files of the four providers", async () => {
    const { stub, models } = await seeded();

    const names = async (viewer: Viewer) =>
      (await models.listHubAccounts(viewer)).map((account) => account.id).toSorted();

    expect(await names(alice)).toEqual(["alice.json"]);
    expect(await names(bob)).toEqual(["bob.json"]);
    // An admin sees Alice's and Bob's private accounts as `limited` only: not on the hub.
    expect(await names(admin)).toEqual(["shared.json"]);
    expect(await names({ member: undefined, admin: true })).toEqual(["shared.json"]);
    expect(await names({ member: undefined, admin: false })).toEqual([]);

    const [listed] = await models.listHubAccounts(alice);
    const { byName } = await indexes(stub);

    expect(listed).toEqual({
      id: "alice.json",
      auth_index: byName.get("alice.json"),
      provider: "codex",
      email: "codex@x.com",
      id_token: { chatgpt_account_id: "acct-1" },
    });
    expect(JSON.stringify(await models.listHubAccounts(admin))).not.toContain("secret");
  });

  it("resolve to nothing they do not list", async () => {
    const { stub, models } = await seeded();
    const { byName, keys } = await indexes(stub);

    expect(keys.length).toBeGreaterThan(0);

    const hidden = [
      [byName.get("off.json"), alice],
      [byName.get("kimi.json"), alice],
      [byName.get("bob.json"), alice],
      [byName.get("shared.json"), alice],
      [byName.get("alice.json"), admin],
      [byName.get("alice.json"), bob],
      ...keys.map((key) => [key, admin] as const),
      ["0000000000000000", admin],
    ] as const;

    for (const [authIndex, viewer] of hidden) {
      expect(authIndex).toBeDefined();
      expect(await models.hubCallTarget(authIndex ?? "", "claude", viewer), authIndex).toEqual({
        ok: false,
        error: "not_found",
      });
      expect(await models.resetHubCooldown(authIndex ?? "", viewer), authIndex).toEqual({
        ok: false,
      });
    }

    const own = byName.get("alice.json")?.toUpperCase() ?? "";

    expect(await models.hubCallTarget(own, "codex", alice)).toMatchObject({
      ok: true,
      target: { provider: "codex", token: "codex-secret-access", accountId: "acct-1" },
    });
    // Another provider's call: refused before any refresh.
    expect(await models.hubCallTarget(own, "claude", alice)).toEqual({
      ok: false,
      error: "wrong_provider",
    });
  });

  it("hand out a token refreshed first when it has expired", async () => {
    const org = OrgId.make(`hub-${crypto.randomUUID().slice(0, 8)}`);
    const models = controlPlane(org).models();

    currentUpstream = (url) =>
      url.includes("platform.claude.com")
        ? Response.json({
            access_token: "sk-ant-oat-fresh",
            refresh_token: "rt-fresh",
            expires_in: 28800,
          })
        : new Response("unexpected", { status: 500 });

    await models.importAuthFile(
      "stale.json",
      JSON.stringify(
        claudeFile({ access_token: "sk-ant-oat-stale", expired: iso(Date.now() - 60_000) }),
      ),
      {},
      admin,
    );

    const [account] = await models.listHubAccounts(admin);
    const target = await models.hubCallTarget(account?.auth_index ?? "", "claude", admin);

    expect(target).toMatchObject({
      ok: true,
      target: { provider: "claude", token: "sk-ant-oat-fresh" },
    });
  });

  it("answer unavailable when the refresh fails", async () => {
    const org = OrgId.make(`hub-${crypto.randomUUID().slice(0, 8)}`);
    const models = controlPlane(org).models();

    currentUpstream = () => new Response("nope", { status: 500 });

    await models.importAuthFile(
      "broken.json",
      JSON.stringify(claudeFile({ expired: iso(Date.now() - 60_000) })),
      {},
      admin,
    );

    const [account] = await models.listHubAccounts(admin);

    expect(await models.hubCallTarget(account?.auth_index ?? "", "claude", admin)).toMatchObject({
      ok: false,
      error: "unavailable",
    });
  });

  it("give an Antigravity account without a project its token for the userinfo call only", async () => {
    const org = OrgId.make(`hub-${crypto.randomUUID().slice(0, 8)}`);
    const models = controlPlane(org).models();

    await models.importAuthFile(
      "ag.json",
      JSON.stringify({
        type: "antigravity",
        email: "ag@x.com",
        access_token: "ag-secret-access",
        refresh_token: "ag-secret-refresh",
        expired: "2999-01-01T00:00:00Z",
      }),
      {},
      admin,
    );

    const [account] = await models.listHubAccounts(admin);
    const authIndex = account?.auth_index ?? "";

    expect(account).toMatchObject({ provider: "antigravity" });
    expect(account?.project_id).toBeUndefined();

    expect(await models.hubCallTarget(authIndex, "antigravity", admin, false)).toMatchObject({
      ok: true,
      target: { provider: "antigravity", token: "ag-secret-access" },
    });

    expect(await models.hubCallTarget(authIndex, "antigravity", admin, true)).toEqual({
      ok: false,
      error: "unavailable",
      message: "credential has no project_id",
    });
  });

  it("have their cooldowns reset", async () => {
    const org = OrgId.make(`hub-${crypto.randomUUID().slice(0, 8)}`);
    const models = controlPlane(org).models();

    await models.importAuthFile("cool.json", JSON.stringify(claudeFile()), {}, admin);
    const request = { providers: ["claude"], model: "claude-sonnet-4-5" };
    const picked = await models.pick(request);

    if (!picked.ok) throw new Error("pick failed");
    await models.report(picked.lease, {
      success: false,
      httpStatus: 429,
      retryAfterMs: 90_000,
      error: { message: "status 429", retryable: false, httpStatus: 429 },
    });
    expect((await models.pick(request)).ok).toBe(false);

    const [account] = await models.listHubAccounts(admin);
    const reset = await models.resetHubCooldown(account?.auth_index ?? "", admin);

    expect(reset).toEqual({
      ok: true,
      authIndex: account?.auth_index,
      models: ["claude-sonnet-4-5"],
    });
    expect((await models.pick(request)).ok).toBe(true);
  });
});
