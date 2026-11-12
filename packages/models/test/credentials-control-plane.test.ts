// ControlPlane credential storage + selection through the Durable Object RPC (Workers pool).
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { withModelsPart } from "./support/models-part.ts";
import { describe, expect, it } from "vite-plus/test";
import type { PickResult } from "../src/credentials/selection/types.ts";

const plane = (name: string = crypto.randomUUID()) => env.CONTROL_PLANE.getByName(name);

const claudeFile = (extra: Record<string, unknown> = {}) => ({
  type: "claude",
  email: "me@x.com",
  access_token: "sk-ant-oat-secret-access",
  refresh_token: "secret-refresh",
  expired: "2999-01-01T00:00:00Z",
  ...extra,
});

const picked = (result: PickResult) => {
  if (!result.ok) throw new Error(`pick failed: ${result.failure.code}`);

  return result;
};

const CONFIG = `
routing:
  strategy: round-robin
  session-affinity: true
oauth:
  model-alias:
    claude:
      - { name: claude-sonnet-4-5, alias: sonnet, force-mapping: true }
`;

describe("ControlPlane credentials (Workers pool)", () => {
  it("imports auth files, lists them redacted and returns the full snapshot from pick", async () => {
    const stub = plane();
    await stub.models().importConfig(CONFIG, "test");

    const imported = await stub
      .models()
      .importAuthFile(
        "claude-a.json",
        JSON.stringify(
          claudeFile({ prefix: "team", headers: { "X-Org": "o1" }, priority: 3, weight: 2 }),
        ),
        {},
        FULL_ACCESS,
      );

    expect(imported).toMatchObject({
      ok: true,
      id: "claude-a.json",
      provider: "claude",
      created: true,
      credentialVersion: 1,
    });

    const list = await stub.models().listCredentials(FULL_ACCESS);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "claude-a.json",
      label: "me@x.com",
      prefix: "team",
      priority: 3,
      weight: 2,
      authKind: "oauth",
    });
    expect(JSON.stringify(list)).not.toContain("secret-access");
    expect(JSON.stringify(list)).not.toContain("secret-refresh");
    expect(list[0]?.headerNames).toEqual(["X-Org"]);

    const result = picked(
      await stub.models().pick({ providers: ["claude"], model: "team/sonnet(8192)" }),
    );

    expect(result.credential).toMatchObject({
      id: "claude-a.json",
      provider: "claude",
      executor: "claude",
      authKind: "oauth",
      prefix: "team",
      headers: { "X-Org": "o1" },
      metadata: { access_token: "sk-ant-oat-secret-access", refresh_token: "secret-refresh" },
      credentialVersion: 1,
    });
    expect(result.route).toMatchObject({
      requestedModel: "team/sonnet(8192)",
      routeModel: "sonnet(8192)",
      upstreamModel: "claude-sonnet-4-5(8192)",
      originalAlias: "sonnet",
      forceMapping: true,
      stateModel: "claude-sonnet-4-5",
    });
    expect(result.lease).toMatchObject({
      credentialId: "claude-a.json",
      credentialVersion: 1,
      model: "claude-sonnet-4-5",
    });
  });

  it("persists credentials and failure state across Durable Object evictions", async () => {
    const name = crypto.randomUUID();
    const stub = plane(name);

    await withModelsPart(stub, async (part) => {
      await part.importAuthFile("claude-a.json", claudeFile(), {}, FULL_ACCESS);
      await part.importAuthFile("claude-b.json", claudeFile({ email: "b@x.com" }), {}, FULL_ACCESS);
      await part.setCredentialDisabled("claude-b.json", true, FULL_ACCESS);

      const result = picked(await part.pick({ providers: ["claude"], model: "claude-sonnet-4-5" }));

      await part.report(result.lease, {
        success: false,
        httpStatus: 500,
        error: { message: "boom Bearer abcdefghijklmnop", retryable: true, httpStatus: 500 },
      });
    });
    await evictDurableObject(stub);
    const fresh = plane(name);
    const list = await fresh.models().listCredentials(FULL_ACCESS);
    expect(list.map((item) => [item.id, item.disabled])).toEqual([
      ["claude-a.json", false],
      ["claude-b.json", true],
    ]);
    expect(list[0]).toMatchObject({ failed: 1, lastError: { httpStatus: 500, retryable: true } });
    expect(JSON.stringify(list[0]?.lastError)).not.toContain("abcdefghijklmnop");
    // The 500's model cooldown survives the eviction too (cooldowns are always persisted)...

    const cooling = await fresh
      .models()
      .pick({ providers: ["claude"], model: "claude-sonnet-4-5" });

    expect(cooling.ok).toBe(false);
    // ...and the disabled credential stays out of selection for another model.

    const after = picked(
      await fresh.models().pick({ providers: ["claude"], model: "claude-opus-4-5" }),
    );

    expect(after.credential.id).toBe("claude-a.json");
  });

  it("serialises concurrent picks: no duplicate leases and a perfectly even rotation", async () => {
    const stub = plane();

    for (const id of ["a", "b", "c"])
      await stub
        .models()
        .importAuthFile(`claude-${id}.json`, claudeFile({ email: `${id}@x.com` }), {}, FULL_ACCESS);

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        stub.models().pick({ providers: ["claude"], model: "claude-sonnet-4-5" }),
      ),
    );

    const ok = results.map(picked);
    const counts: Record<string, number> = {};

    for (const item of ok) counts[item.credential.id] = (counts[item.credential.id] ?? 0) + 1;
    expect(counts).toEqual({ "claude-a.json": 10, "claude-b.json": 10, "claude-c.json": 10 });
    expect(new Set(ok.map((item) => item.lease.id)).size).toBe(30);
  });

  it("synthesises provider keys, applies model aliases and follows config changes", async () => {
    const stub = plane();
    await stub.models().importConfig(
      `
routing:
  strategy: fill-first
api-keys:
  openai-compatibility:
    - name: Router
      base-url: https://router.example/v1
      headers: { X-Title: proxy }
      models:
        - { name: gpt-4o, alias: smart }
      keys:
        - { api-key: key-1, weight: 1 }
        - { api-key: key-2 }
`,
      "test",
    );

    const first = picked(
      await stub.models().pick({ providers: ["openai-compatible-router"], model: "smart" }),
    );

    expect(first.credential).toMatchObject({
      source: "config",
      authKind: "apikey",
      baseUrl: "https://router.example/v1",
      headers: { "X-Title": "proxy" },
    });
    // fill-first takes the smallest credential id, which is content-addressed (hash order)
    const ids = (await stub.models().listCredentials(FULL_ACCESS)).map((item) => item.id);
    expect(first.credential.id).toBe(ids.toSorted()[0]);
    expect(["key-1", "key-2"]).toContain(first.credential.attributes.api_key);
    expect(first.credential.id).toMatch(/^openai-compatibility:router:[0-9a-f]{12}$/);
    expect(first.route).toMatchObject({ requestedModel: "smart", upstreamModel: "gpt-4o" });
    expect(JSON.stringify(await stub.models().listCredentials(FULL_ACCESS))).not.toMatch(
      /"key-[12]"/,
    ); // api keys are masked

    // models outside the configured list are not served; config edits take effect immediately
    expect(
      (await stub.models().pick({ providers: ["openai-compatible-router"], model: "unknown" })).ok,
    ).toBe(false);
    await stub.models().importConfig(
      `
routing:
  strategy: fill-first
api-keys:
  openai-compatibility:
    - name: Router
      base-url: https://router.example/v1
      models: [{ name: gpt-4o, alias: smart }]
      keys: [{ api-key: key-3 }]
`,
      "test",
    );

    const second = picked(
      await stub.models().pick({ providers: ["openai-compatible-router"], model: "smart" }),
    );

    expect(second.credential.attributes.api_key).toBe("key-3");
    expect(second.credential.id).not.toBe(first.credential.id);
  });

  it("rotates the upstream models of a shared alias between requests", async () => {
    const stub = plane();
    await stub.models().importConfig(
      `
api-keys:
  openai-compatibility:
    - name: Pool
      base-url: https://pool.example/v1
      models: [{ name: m-a, alias: shared }, { name: m-b, alias: shared }]
      keys: [{ api-key: k }]
`,
      "test",
    );
    const firsts = [];

    for (let index = 0; index < 4; index += 1) {
      const result = picked(
        await stub.models().pick({ providers: ["openai-compatible-pool"], model: "shared" }),
      );

      expect(result.route.upstreamModels.toSorted()).toEqual(["m-a", "m-b"]);
      firsts.push(result.route.upstreamModel);
    }

    expect(firsts).toEqual(["m-a", "m-b", "m-a", "m-b"]);
  });

  it("merges on update, bumps the credential version on token changes and discards stale reports", async () => {
    const stub = plane();
    await stub
      .models()
      .importAuthFile(
        "claude-a.json",
        claudeFile({ prefix: "team", note: "keep" }),
        {},
        FULL_ACCESS,
      );
    const before = picked(await stub.models().pick({ providers: ["claude"], model: "m" }));

    // A re-login (merge) keeps user settings, replaces tokens and bumps the version.
    const relogin = await stub.models().upsertCredential("claude-a.json", {
      type: "claude",
      access_token: "new-token",
      refresh_token: "new-r",
    });

    expect(relogin).toMatchObject({
      ok: true,
      created: false,
      credentialVersion: 2,
      credentialsChanged: true,
    });
    const after = picked(await stub.models().pick({ providers: ["claude"], model: "team/m" }));
    expect(after.credential.metadata).toMatchObject({
      access_token: "new-token",
      note: "keep",
      prefix: "team",
    });

    // A settings-only update keeps the version.
    const same = await stub.models().upsertCredential("claude-a.json", {
      type: "claude",
      access_token: "new-token",
      refresh_token: "new-r",
      priority: 4,
    });

    expect(same).toMatchObject({ credentialVersion: 2, credentialsChanged: false });

    // Results for the old credential material are ignored.
    expect(await stub.models().report(before.lease, { success: false, httpStatus: 401 })).toEqual({
      ok: true,
      applied: false,
    });
    expect(await stub.models().report(after.lease, { success: true })).toEqual({
      ok: true,
      applied: true,
    });
    expect((await stub.models().listCredentials(FULL_ACCESS))[0]).toMatchObject({
      success: 1,
      failed: 0,
    });

    // A verbatim import replaces the file entirely.
    await stub
      .models()
      .importAuthFile(
        "claude-a.json",
        JSON.stringify({ type: "claude", access_token: "x" }),
        {},
        FULL_ACCESS,
      );
    const replaced = (await stub.models().listCredentials(FULL_ACCESS))[0];
    expect(replaced?.metadata).not.toHaveProperty("note");
  });

  it("setDisabled, remove and import validation", async () => {
    const stub = plane();
    await stub.models().importAuthFile("claude-a.json", claudeFile(), {}, FULL_ACCESS);
    expect(await stub.models().setCredentialDisabled("claude-a.json", true, FULL_ACCESS)).toEqual({
      ok: true,
    });
    const blocked = await stub.models().pick({ providers: ["claude"], model: "m" });
    expect(blocked).toMatchObject({ ok: false, failure: { code: "auth_not_found" } });
    expect(await stub.models().setCredentialDisabled("claude-a.json", false, FULL_ACCESS)).toEqual({
      ok: true,
    });
    expect((await stub.models().pick({ providers: ["claude"], model: "m" })).ok).toBe(true);
    expect(await stub.models().setCredentialDisabled("nope.json", true, FULL_ACCESS)).toEqual({
      ok: false,
      error: "not_found",
    });

    expect(await stub.models().removeCredential("claude-a.json", FULL_ACCESS)).toEqual({
      removed: true,
    });
    expect(await stub.models().removeCredential("claude-a.json", FULL_ACCESS)).toEqual({
      removed: false,
    });
    expect(await stub.models().listCredentials(FULL_ACCESS)).toEqual([]);

    expect(await stub.models().importAuthFile("bad.json", "{", {}, FULL_ACCESS)).toMatchObject({
      ok: false,
      reason: "invalid_json",
    });
    expect(
      await stub
        .models()
        .importAuthFile("w.json", JSON.stringify({ type: "claude", weight: 1.5 }), {}, FULL_ACCESS),
    ).toMatchObject({
      ok: false,
      reason: "invalid_weight",
    });
    expect(
      await stub
        .models()
        .importAuthFile("g.json", JSON.stringify({ type: "gemini" }), {}, FULL_ACCESS),
    ).toMatchObject({
      ok: false,
      reason: "unsupported_type",
    });
  });

  it("never selects an expired OAuth token", async () => {
    const stub = plane();
    await stub
      .models()
      .importAuthFile(
        "claude-old.json",
        claudeFile({ expired: "2001-01-01T00:00:00Z" }),
        {},
        FULL_ACCESS,
      );
    expect(await stub.models().pick({ providers: ["claude"], model: "m" })).toMatchObject({
      ok: false,
      failure: { code: "auth_unavailable" },
    });
    await stub.models().importAuthFile("claude-new.json", claudeFile(), {}, FULL_ACCESS);
    expect(
      picked(await stub.models().pick({ providers: ["claude"], model: "m" })).credential.id,
    ).toBe("claude-new.json");
  });

  it("session affinity binds a session and is released by a credential failure (per caller scope)", async () => {
    const stub = plane();
    await stub.models().importConfig("routing: { session-affinity: true }", "test");

    for (const id of ["a", "b", "c"])
      await stub
        .models()
        .importAuthFile(`claude-${id}.json`, claudeFile({ email: `${id}@x.com` }), {}, FULL_ACCESS);

    const request = (callerScope: string) => ({
      providers: ["claude"],
      model: "claude-sonnet-4-5",
      session: { id: "session-1", callerScope },
    });

    const first = picked(await stub.models().pick(request("alice")));

    for (let index = 0; index < 5; index += 1) {
      expect(picked(await stub.models().pick(request("alice"))).credential.id).toBe(
        first.credential.id,
      );
    }

    // Another caller does not share the binding.
    const bob = picked(await stub.models().pick(request("bob")));
    expect(bob.credential.id).not.toBe(first.credential.id);

    // A request-scoped failure keeps the binding; a credential failure releases it.
    await stub
      .models()
      .report(first.lease, { success: false, httpStatus: 400, requestScoped: true });
    expect(picked(await stub.models().pick(request("alice"))).credential.id).toBe(
      first.credential.id,
    );
    await stub.models().report(first.lease, { success: false, httpStatus: 503 });
    const rebound = picked(await stub.models().pick(request("alice")));
    expect(rebound.credential.id).not.toBe(first.credential.id);
  });

  it("reports unknown credentials and requests without providers", async () => {
    const stub = plane();

    const lease = {
      id: "l",
      credentialId: "gone",
      credentialVersion: 1,
      provider: "claude",
      model: "m",
      issuedAt: 0,
    };

    expect(await stub.models().report(lease, { success: true })).toEqual({
      ok: false,
      error: "unknown_credential",
    });
    expect(await stub.models().pick({ providers: [], model: "m" })).toMatchObject({
      ok: false,
      failure: { code: "provider_not_found" },
    });
  });
});
