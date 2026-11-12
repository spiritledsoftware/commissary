// The panel's batch account actions (`POST /credentials/batch`) and "Check all quotas" (`POST
// /credentials/quota/all`) through the router with the real ControlPlane: per-account results, partial failure, unknown
// names, the admin gate, cross-site write protection, the sweep lease shared with the cron task (renewal, expiry,
// release however the sweep ends), and the contract.
import { assert, describe, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { afterAll, beforeAll, beforeEach, expect } from "vite-plus/test";
import { ManagementApi } from "@commissary/contract/api";
import { ManagementError } from "@commissary/contract/errors";
import { WorkerExecutionContext, CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import type { Json } from "@commissary/json";
import { LEASE_TTL_MS, type LeaseSource, type TakeLease } from "@commissary/state";
import {
  claudeFile,
  controlPlane,
  type Harness,
  jsonInit,
  makeHarness,
  resetControlPlane,
  token,
} from "./support/management.ts";
import { envContext } from "../src/worker-env.ts";
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  emptyState,
  FULL_ACCESS,
  LEASE_RENEW_INTERVAL_MS,
  makePool,
  MemoryPoolStore,
  mockHttp,
  type MockReply,
  RESET_GRANT_STATUS_URL,
  routes,
  runQuotaSweep,
  sweepQuotas,
} from "@commissary/models/testing";

const BATCH = "/v9/management/credentials/batch";

const QUOTA_ALL = "/v9/management/credentials/quota/all";

const USAGE = {
  five_hour: { utilization: 12, resets_at: "2026-10-10T15:00:00Z" },
  seven_day: { utilization: 40, resets_at: "2026-10-14T00:00:00Z" },
};

/** The usage endpoint answers by the account's token: `sk-ant-oat-broken` gets a 401. */
const usage = (authorization: string | undefined): MockReply =>
  authorization === "Bearer sk-ant-oat-broken"
    ? { status: 401, body: { error: "token secret-bearing body" } }
    : { status: 200, body: USAGE };

const harness = makeHarness(
  routes({
    [`GET ${CLAUDE_USAGE_URL}`]: (request) => usage(request.headers.authorization),
    [`GET ${CLAUDE_PROFILE_URL}`]: { status: 200, body: { account: { has_claude_max: true } } },
    [`GET ${RESET_GRANT_STATUS_URL}`]: { status: 200, body: { cedar_ember: { eligible: false } } },
  }),
);

// Token refreshes run inside the ControlPlane (same isolate) through the global `fetch`: one stable stand-in that
// delegates to the current test's upstream.
const refreshed = () =>
  Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });

let refreshUpstream: () => Response | Promise<Response> = refreshed;

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = async () => refreshUpstream();
});

const takeLease = async (source: LeaseSource): Promise<TakeLease> =>
  await controlPlane().models().takeQuotaSweepLease(source);

/** Runs SQL inside the global ControlPlane (the lease row has no RPC to set its times). */
const leaseSql = async (query: string, ...bindings: number[]): Promise<void> => {
  await runInDurableObject(controlPlane(), (_instance, state) => {
    state.storage.sql.exec(query, ...bindings);
  });
};

/** Frees the sweep lease whatever holds it; nothing does before its table exists (first taken: the lease store). */
const freeLease = async (): Promise<void> => {
  await runInDurableObject(controlPlane(), (_instance, state) => {
    const { sql } = state.storage;
    const table = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quota_sweep_lease'";

    if (sql.exec(table).toArray().length > 0) sql.exec("DELETE FROM quota_sweep_lease");
  });
};

/** Makes the stored lease look last renewed `ms` earlier. */
const ageLease = (ms: number) =>
  leaseSql("UPDATE quota_sweep_lease SET renewed_at = renewed_at - ?", ms);

/** Resolves once `ready()` holds, checking between macrotasks (the requests in flight make progress meanwhile). */
const until = async (ready: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 500 && !ready(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  expect(ready()).toBe(true);
};

beforeEach(async () => {
  refreshUpstream = refreshed;
  harness.requests.length = 0;
  await resetControlPlane();
  await freeLease();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await harness.dispose();
});

const seed = async (name: string, extra: Record<string, unknown> = {}): Promise<void> => {
  const result = await controlPlane()
    .models()
    .importAuthFile(name, JSON.stringify(claudeFile(extra)), {}, FULL_ACCESS);

  expect(result.ok).toBe(true);
};

const batch = (body: Json) => harness.json(BATCH, jsonInit("POST", body));

interface Listed {
  readonly name: string;
  readonly disabled: boolean;
}

const files = async (): Promise<ReadonlyArray<Listed>> => {
  const { body } = await harness.json("/v9/management/credentials");

  // SAFETY: `GET /credentials` answers `{files: [...]}` (decoded with the contract in the contract tests below).
  return (body as { files: ReadonlyArray<Listed> }).files;
};

describe("POST /credentials/batch", () => {
  it("disables and enables every named account and answers per account, in order", async () => {
    await seed("a.json");
    await seed("b.json");
    await seed("c.json");

    const disabled = await batch({ action: "disable", names: ["b.json", "a.json"] });

    expect(disabled).toMatchObject({
      status: 200,
      body: {
        action: "disable",
        results: [
          { name: "b.json", ok: true },
          { name: "a.json", ok: true },
        ],
        succeeded: 2,
        failed: 0,
      },
    });
    expect((await files()).map((file) => [file.name, file.disabled])).toEqual([
      ["a.json", true],
      ["b.json", true],
      ["c.json", false],
    ]);

    const enabled = await batch({ action: "enable", names: ["a.json"] });

    expect(enabled.body).toMatchObject({ succeeded: 1, failed: 0 });
    expect((await files()).find((file) => file.name === "a.json")?.disabled).toBe(false);
  });

  it("reports unknown names and provider keys as not_found next to the ones that succeeded", async () => {
    await seed("a.json");
    await controlPlane()
      .models()
      .importConfig("api-keys:\n  claude:\n    - keys: [{ api-key: sk-ant-x }]\n", "test");

    const configKey = (await controlPlane().models().listCredentials(FULL_ACCESS)).find(
      (entry) => entry.source === "config",
    );

    expect(configKey).toBeDefined();
    const configId = configKey?.id ?? "";

    const { status, body } = await batch({
      action: "disable",
      names: ["a.json", "ghost.json", configId, " a.json ", "../evil", "a.json"],
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      action: "disable",
      results: [
        { name: "a.json", ok: true },
        { name: "ghost.json", ok: false, error: "not_found", message: "auth file not found" },
        { name: configId, ok: false, error: "not_found", message: "auth file not found" },
        // Names are exact file names: not trimmed.
        { name: " a.json ", ok: false, error: "not_found", message: "auth file not found" },
        { name: "../evil", ok: false, error: "not_found", message: "auth file not found" },
      ],
      succeeded: 1,
      failed: 4,
      skipped: 0,
    });

    // A delete answers a config id like any name that is no auth file: the reply confirms no guessed key.
    const deleted = await batch({ action: "delete", names: [configId, "ghost.json"] });

    expect(deleted.body).toMatchObject({
      results: [
        { name: configId, ok: true },
        { name: "ghost.json", ok: true },
      ],
    });
    expect(
      (await controlPlane().models().listCredentials(FULL_ACCESS)).some(
        (entry) => entry.id === configId,
      ),
    ).toBe(true);
  });

  it("deletes the named accounts, keeping the rest; a name already gone counts as deleted", async () => {
    await seed("a.json");
    await seed("b.json");
    await seed("keep.json");

    const { body } = await batch({ action: "delete", names: ["a.json", "b.json", "ghost.json"] });

    expect(body).toMatchObject({ succeeded: 3, failed: 0 });
    expect((await files()).map((file) => file.name)).toEqual(["keep.json"]);

    const again = await batch({ action: "delete", names: ["a.json"] });

    expect(again.body).toMatchObject({
      results: [{ name: "a.json", ok: true }],
      succeeded: 1,
      failed: 0,
    });
  });

  it("a batch delete clears what a single delete clears and re-arms the refresh alarm", async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();

    await seed("a.json", { expired: soon });
    await seed("b.json", { expired: soon });
    // A quota report and runtime state for both.
    expect((await harness.json(QUOTA_ALL, { method: "POST" })).status).toBe(200);
    await leaseSql(
      "INSERT OR REPLACE INTO credential_state (id, state, updated_at) SELECT id, '{}', 0 FROM credentials",
    );

    const counts = async () =>
      await runInDurableObject(controlPlane(), async (_instance, state) => ({
        reports: state.storage.sql
          .exec("SELECT id FROM credential_quota_report ORDER BY id")
          .toArray()
          .map((row) => row.id),
        states: state.storage.sql
          .exec("SELECT id FROM credential_state ORDER BY id")
          .toArray()
          .map((row) => row.id),
        grants: state.storage.sql
          .exec("SELECT id FROM credential_reset_grants WHERE status IS NOT NULL ORDER BY id")
          .toArray()
          .map((row) => row.id),
        alarm: await state.storage.getAlarm(),
      }));

    const before = await counts();

    expect(before.reports).toEqual(["a.json", "b.json"]);
    expect(before.states).toEqual(["a.json", "b.json"]);
    expect(before.grants).toEqual(["a.json", "b.json"]);
    expect(before.alarm).not.toBeNull();

    expect((await batch({ action: "delete", names: ["a.json", "b.json"] })).body).toMatchObject({
      succeeded: 2,
    });

    // The same as deleting them one by one: nothing of theirs is left, and with no account to refresh no alarm.
    expect(await counts()).toEqual({ reports: [], states: [], grants: [], alarm: null });

    // A re-import under the same name starts clean: no report of the deleted account shows up.
    await seed("a.json");
    const { body } = await harness.json("/v9/management/credentials");

    expect(body).toMatchObject({ files: [{ name: "a.json" }] });
    expect(body).not.toHaveProperty(["files", 0, "quota_report"]);
  });

  it("refreshes tokens per account; an account without a refresh token is skipped", async () => {
    await seed("a.json");
    await controlPlane()
      .models()
      .importAuthFile(
        "noref.json",
        JSON.stringify({ type: "claude", email: "n@x.com", access_token: "t" }),
        {},
        FULL_ACCESS,
      );

    const ok = await batch({ action: "refresh", names: ["a.json", "noref.json"] });

    expect(ok.body).toEqual({
      action: "refresh",
      results: [
        { name: "a.json", ok: true },
        {
          name: "noref.json",
          ok: false,
          skipped: true,
          error: "not_refreshable",
          message: "the account has no refresh token",
        },
      ],
      succeeded: 1,
      failed: 0,
      skipped: 1,
    });
    expect(
      (await controlPlane().models().getCredentialFile("a.json", FULL_ACCESS))?.access_token,
    ).toBe("new-access");
  });

  it("a failed refresh gives a fixed reason and the status, never the upstream body", async () => {
    await seed("a.json", { refresh_token: "rt-echoed-secret" });

    // The upstream echoes the refresh token it was sent.
    refreshUpstream = () =>
      Response.json(
        {
          error: "invalid_request",
          error_description: "refresh_token rt-echoed-secret is malformed",
        },
        { status: 400 },
      );

    const partial = await batch({ action: "refresh", names: ["a.json", "ghost.json"] });

    expect(partial.status).toBe(200);
    expect(partial.body).toEqual({
      action: "refresh",
      results: [
        {
          name: "a.json",
          ok: false,
          error: "refresh_failed",
          message: "the token refresh failed (HTTP 400)",
          status: 400,
        },
        { name: "ghost.json", ok: false, error: "not_found", message: "auth file not found" },
      ],
      succeeded: 0,
      failed: 2,
      skipped: 0,
    });

    const text = JSON.stringify(partial.body);

    expect(text).not.toContain("rt-echoed-secret");
    expect(text).not.toContain("refresh_token");
    expect(text).not.toContain("malformed");
  });

  it("runs at most four token refreshes at once", async () => {
    const names = Array.from({ length: 10 }, (_, index) => `r${index}.json`);

    for (const name of names) await seed(name);
    let inFlight = 0;
    let most = 0;

    refreshUpstream = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;

      return refreshed();
    };

    const { body } = await batch({ action: "refresh", names });

    expect(body).toMatchObject({ succeeded: 10, failed: 0 });
    expect(most).toBe(4);
  });

  it("refuses malformed requests with 400", async () => {
    expect(await batch({ action: "explode", names: ["a.json"] })).toMatchObject({
      status: 400,
      body: { error: "invalid body" },
    });
    expect((await batch({ action: "disable" })).status).toBe(400);
    expect((await batch({ action: "disable", names: [1] })).status).toBe(400);
    expect(await batch({ action: "disable", names: [""] })).toMatchObject({
      status: 400,
      body: { error: "names is required" },
    });

    const many = Array.from({ length: 101 }, (_, index) => `f${index}.json`);

    expect(await batch({ action: "delete", names: many })).toMatchObject({
      status: 400,
      body: { error: "too many names" },
    });
    // Duplicates count once.
    expect(
      (await batch({ action: "delete", names: [...many.slice(0, 100), "f0.json"] })).status,
    ).toBe(200);

    // A refresh is capped lower: each name is an upstream call.
    expect(await batch({ action: "refresh", names: many.slice(0, 21) })).toMatchObject({
      status: 400,
      body: { error: "too many names" },
    });

    // The body is read up to 64 KiB.
    const huge = await harness.call(
      BATCH,
      jsonInit("POST", { action: "disable", names: ["x".repeat(70 * 1024)] }),
    );

    expect(huge.status).toBe(413);
    await huge.body?.cancel();
  });

  it("is for admins only", async () => {
    await seed("a.json");

    const anonymous = await harness.call(BATCH, {
      ...jsonInit("POST", { action: "delete", names: ["a.json"] }),
      auth: false,
    });

    expect(anonymous.status).toBe(401);
    await anonymous.body?.cancel();

    const stranger = await harness.call(BATCH, {
      ...jsonInit("POST", { action: "delete", names: ["a.json"] }),
      auth: await token("other@example.com"),
    });

    // A plain member's batch reaches their own private accounts only: the shared file stays, and its name reads as
    // already gone (a delete answers every unknown name `ok`).
    expect(stranger.status).toBe(200);
    await stranger.body?.cancel();
    expect((await files()).map((file) => file.name)).toEqual(["a.json"]);
  });

  it("refuses cross-site writes like the other management writes and accepts same-origin ones", async () => {
    await seed("a.json");
    const body = JSON.stringify({ action: "delete", names: ["a.json"] });

    const forged = await harness.call(BATCH, {
      method: "POST",
      headers: {
        origin: "https://evil.test",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body,
    });

    expect(forged.status).toBe(403);
    await forged.body?.cancel();

    const simple = await harness.call(BATCH, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });

    expect(simple.status).toBe(415);
    await simple.body?.cancel();
    expect((await files()).map((file) => file.name)).toEqual(["a.json"]);

    const same = await harness.call(BATCH, {
      method: "POST",
      headers: {
        origin: "https://commissary.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body,
    });

    expect(same.status).toBe(200);
    await same.body?.cancel();
    expect(await files()).toEqual([]);
  });
});

describe("POST /credentials/quota/all", () => {
  it("checks every enabled account that reports quota and answers each outcome", async () => {
    await seed("a.json");
    await seed("broken.json", { access_token: "sk-ant-oat-broken" });
    await seed("off.json", { disabled: true });
    await controlPlane()
      .models()
      .importAuthFile(
        "qwen-a.json",
        JSON.stringify({ type: "qwen", access_token: "t", expired: "2999-01-01T00:00:00Z" }),
        {},
        FULL_ACCESS,
      );

    const { status, body } = await harness.json(QUOTA_ALL, { method: "POST" });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      results: [
        { name: "a.json", ok: true },
        {
          name: "broken.json",
          ok: false,
          error: "check_failed",
          message: "usage endpoint answered 401",
        },
      ],
      checked: 1,
      failed: 1,
    });

    // SAFETY: matched above.
    const { started_at, finished_at } = body as { started_at: string; finished_at: string };

    expect(Date.parse(finished_at)).toBeGreaterThanOrEqual(Date.parse(started_at));
    expect(JSON.stringify(body)).not.toContain("secret");

    // The lease was given back: a second check runs.
    expect((await harness.json(QUOTA_ALL, { method: "POST" })).status).toBe(200);
  });

  it("answers 409 without asking any provider while another sweep holds the lease", async () => {
    await seed("a.json");
    const held = await takeLease("cron");

    expect(held.ok).toBe(true);

    const { status, body } = await harness.json(QUOTA_ALL, { method: "POST" });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "quota_check_running" });
    // SAFETY: matched above.
    expect((body as { message: string }).message).toContain("the scheduled check");
    expect(harness.requests).toHaveLength(0);

    if (held.ok) await controlPlane().models().releaseQuotaSweepLease(held.lease.token);
    expect((await harness.json(QUOTA_ALL, { method: "POST" })).status).toBe(200);
  });

  it("takes over a lease not renewed for longer than its lifetime", async () => {
    await seed("a.json");
    await takeLease("panel");
    await ageLease(LEASE_TTL_MS - 5_000);
    expect((await harness.json(QUOTA_ALL, { method: "POST" })).status).toBe(409);

    await ageLease(10_000);
    expect((await harness.json(QUOTA_ALL, { method: "POST" })).status).toBe(200);
  });

  it("lets one of two concurrent checks run and refuses the other", async () => {
    await seed("a.json");
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));

    const slow = makeHarness(
      routes({
        [`GET ${CLAUDE_USAGE_URL}`]: async () => {
          await gate;

          return { status: 200, body: USAGE };
        },
        [`GET ${CLAUDE_PROFILE_URL}`]: { status: 200, body: {} },
        [`GET ${RESET_GRANT_STATUS_URL}`]: { status: 404 },
      }),
    );

    try {
      const first = slow.json(QUOTA_ALL, { method: "POST" });

      await until(() => slow.requests.length > 0);

      const second = await slow.json(QUOTA_ALL, { method: "POST" });

      expect(second).toMatchObject({ status: 409, body: { error: "quota_check_running" } });
      open();
      expect(await first).toMatchObject({ status: 200, body: { checked: 1 } });
      // Released at the end: the next check runs.
      expect((await slow.json(QUOTA_ALL, { method: "POST" })).status).toBe(200);
    } finally {
      open();
      await slow.dispose();
    }
  });

  it("is for admins only and refuses cross-site requests", async () => {
    const anonymous = await harness.call(QUOTA_ALL, { method: "POST", auth: false });

    expect(anonymous.status).toBe(401);
    await anonymous.body?.cancel();

    // A plain member sweeps their own private accounts: none here, so nothing is checked.
    const stranger = await harness.call(QUOTA_ALL, {
      method: "POST",
      auth: await token("other@example.com"),
    });

    expect(stranger.status).toBe(200);
    expect(await stranger.json()).toMatchObject({ checked: 0, failed: 0, results: [] });

    const forged = await harness.call(QUOTA_ALL, {
      method: "POST",
      headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" },
    });

    expect(forged.status).toBe(403);
    await forged.body?.cancel();
    expect(harness.requests).toHaveLength(0);
  });

  it.effect("the cron task skips its run while the panel's check holds the lease", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seed("a.json"));

      const held = yield* Effect.promise(() => takeLease("panel"));

      const outbound = mockHttp(() => ({ status: 500 }));

      const summary = yield* runQuotaSweep.pipe(
        Effect.provide(outbound.layer),
        Effect.provideContext(envContext(env)),
      );

      assert.deepStrictEqual(summary, { checked: 0, failed: 0, skipped: true });
      assert.lengthOf(outbound.requests, 0);

      // The skipped run left the panel's lease alone.
      const again = yield* Effect.promise(() => takeLease("cron"));

      assert.isFalse(again.ok);

      if (held.ok)
        yield* Effect.promise(() =>
          controlPlane().models().releaseQuotaSweepLease(held.lease.token),
        );
    }).pipe(Effect.provideService(CurrentOrg, GLOBAL_ORG)),
  );
});

describe("recordQuotaReport", () => {
  it("drops an outcome for tokens replaced during the check, as a refresh result is dropped", async () => {
    await seed("a.json");

    const version = (await controlPlane().models().listCredentials(FULL_ACCESS)).find(
      (entry) => entry.id === "a.json",
    )?.credentialVersion;

    expect(version).toBeDefined();
    const outcome = { ok: true as const, windows: [] };

    // A re-login meanwhile bumps the version: the old check says nothing about the new tokens.
    await controlPlane()
      .models()
      .importAuthFile(
        "a.json",
        JSON.stringify(claudeFile({ access_token: "sk-ant-oat-new" })),
        {},
        FULL_ACCESS,
      );

    expect(
      await controlPlane()
        .models()
        .recordQuotaReport("a.json", outcome, Date.now(), {
          credentialVersion: version ?? 0,
        }),
    ).toEqual({ kind: "stale" });
    expect(await controlPlane().models().getCredentialFile("a.json", FULL_ACCESS)).toBeDefined();

    const current = (await controlPlane().models().listCredentials(FULL_ACCESS)).find(
      (entry) => entry.id === "a.json",
    )?.credentialVersion;

    expect(
      await controlPlane()
        .models()
        .recordQuotaReport("a.json", outcome, Date.now(), {
          credentialVersion: current ?? 0,
        }),
    ).toMatchObject({ kind: "stored" });
    expect(
      await controlPlane().models().recordQuotaReport("ghost.json", outcome, Date.now()),
    ).toEqual({
      kind: "gone",
    });
  });

  it("renews the sweep lease it is given", async () => {
    await seed("a.json");
    const taken = await takeLease("cron");

    assert(taken.ok);
    await ageLease(LEASE_TTL_MS - 1_000);
    await controlPlane()
      .models()
      .recordQuotaReport("a.json", { ok: false, error: "x" }, Date.now(), {
        sweepLease: taken.lease.token,
      });
    await ageLease(5_000);
    // Renewed a moment ago: still held.
    expect((await takeLease("panel")).ok).toBe(false);
  });
});

describe("pool batch writes", () => {
  it("change the in-memory state only once the storage transaction committed", async () => {
    const store = new MemoryPoolStore();

    store.upsert("a.json", "claude", { type: "claude", email: "a@x.dev", access_token: "t" });
    store.states.set("a.json", { ...emptyState(), status: "error" });
    const { pool } = await makePool("{}\n", { store });

    /** A transaction that writes, then rolls back (restores the store) and throws. */
    const rolledBack = (write: () => string[]): string[] => {
      const before = new Map(store.credentials);

      write();
      store.credentials.clear();

      for (const [id, record] of before) store.credentials.set(id, record);

      throw new Error("rolled back");
    };

    expect(() => pool.removeMany(["a.json"], rolledBack)).toThrow("rolled back");
    expect(pool.entry("a.json")?.state.status).toBe("error");
    expect(() => pool.setDisabledMany(["a.json"], true, rolledBack)).toThrow("rolled back");
    expect(pool.entry("a.json")?.credential.disabled).toBe(false);

    expect(pool.removeMany(["a.json"])).toEqual(["a.json"]);
    expect(pool.entry("a.json")).toBeUndefined();
  });
});

/** A ControlPlane stand-in for `sweepQuotas` alone: what it was asked, and failures on demand. */
const fakePlane = (behaviour: {
  readonly targets: () => Promise<string[]>;
  /** Whether a renewal still holds the lease (default: yes). */
  readonly renew?: () => boolean;
  /** Awaited before the lease is handed out. */
  readonly take?: () => Promise<void>;
  /** Awaited before an account's probe target is handed out (the token refresh `ensureFresh` may run). */
  readonly target?: () => Promise<void>;
}) => {
  const calls: string[] = [];

  const stub = {
    takeQuotaSweepLease: async (source: LeaseSource): Promise<TakeLease> => {
      calls.push(`take:${source}`);
      await behaviour.take?.();

      return { ok: true, lease: { token: "tok", source, startedAt: 1, renewedAt: 1 } };
    },
    quotaCheckTargets: async () => {
      calls.push("targets");

      return await behaviour.targets();
    },
    quotaProbeTarget: async () => {
      calls.push("target");
      await behaviour.target?.();

      return {
        ok: true,
        target: { id: "a.json", provider: "claude", token: "sk-ant-oat-x", credentialVersion: 1 },
      };
    },
    recordQuotaReport: async () => ({ kind: "gone" }),
    renewQuotaSweepLease: async () => {
      calls.push("renew");

      return behaviour.renew?.() ?? true;
    },
    releaseQuotaSweepLease: async (token: string) => {
      calls.push(`release:${token}`);
    },
  };

  // SAFETY: `sweepQuotas` reaches the ControlPlane only through these methods of `getByName("global").models()`.
  const fakeEnv = {
    CONTROL_PLANE: { getByName: () => ({ models: () => stub }) },
  } as unknown as Env;

  return { calls, fakeEnv };
};

/** An execution context that records what it was asked to keep alive. */
const recordingContext = () => {
  const held: Promise<unknown>[] = [];

  // SAFETY: `holdInvocation` only calls `waitUntil`.
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => held.push(promise),
  } as unknown as ExecutionContext;

  return { held, ctx };
};

describe("sweepQuotas gives the lease back", () => {
  it.effect("when the sweep fails midway, and holds the invocation open until it has", () =>
    Effect.gen(function* () {
      const plane = fakePlane({
        targets: async () => {
          throw new Error("storage reset");
        },
      });

      const { held, ctx } = recordingContext();

      const failed = yield* sweepQuotas("panel", FULL_ACCESS).pipe(
        Effect.provide(mockHttp(() => ({ status: 500 })).layer),
        Effect.provideContext(envContext(plane.fakeEnv)),
        Effect.provideService(WorkerExecutionContext, ctx),
        Effect.flip,
      );

      assert.strictEqual(failed._tag, "QuotaControlPlaneError");
      assert.deepStrictEqual(plane.calls, ["take:panel", "targets", "release:tok"]);
      assert.lengthOf(held, 1);
      // Settled: the hold ended once the lease was given back.
      yield* Effect.promise(() => held[0] ?? Promise.resolve());
    }).pipe(Effect.provideService(CurrentOrg, GLOBAL_ORG)),
  );

  it.effect("when the request is cancelled while a provider is being asked", () =>
    Effect.gen(function* () {
      const plane = fakePlane({ targets: async () => ["a.json"] });
      const { held, ctx } = recordingContext();
      let asked = false;

      const hanging = mockHttp(async () => {
        asked = true;

        return await new Promise<MockReply>(() => undefined);
      });

      const fiber = yield* sweepQuotas("panel", FULL_ACCESS).pipe(
        Effect.provide(hanging.layer),
        Effect.provideContext(envContext(plane.fakeEnv)),
        Effect.provideService(WorkerExecutionContext, ctx),
        Effect.forkChild,
      );

      yield* Effect.promise(() => until(() => asked));
      yield* Fiber.interrupt(fiber);

      assert.deepStrictEqual(plane.calls, ["take:panel", "targets", "target", "release:tok"]);
      assert.lengthOf(held, 1);
      yield* Effect.promise(() => held[0] ?? Promise.resolve());
    }).pipe(Effect.provideService(CurrentOrg, GLOBAL_ORG)),
  );

  it.effect(
    "when cancelled while the lease is being taken: the take completes, then the lease goes back",
    () =>
      Effect.gen(function* () {
        let open: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (open = resolve));
        const plane = fakePlane({ targets: async () => [], take: () => gate });
        const { held, ctx } = recordingContext();

        const fiber = yield* sweepQuotas("panel", FULL_ACCESS).pipe(
          Effect.provide(mockHttp(() => ({ status: 500 })).layer),
          Effect.provideContext(envContext(plane.fakeEnv)),
          Effect.provideService(WorkerExecutionContext, ctx),
          Effect.forkChild,
        );

        yield* Effect.promise(() => until(() => plane.calls.length > 0));
        const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);

        // The interruption is pending while the take is still in flight.
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
        open();
        yield* Fiber.join(interrupted);

        assert.deepStrictEqual(plane.calls, ["take:panel", "release:tok"]);
        assert.lengthOf(held, 1);
        yield* Effect.promise(() => held[0] ?? Promise.resolve());
      }).pipe(Effect.provideService(CurrentOrg, GLOBAL_ORG)),
  );
});

describe("sweepQuotas keeps its lease", () => {
  /** Lets the fibers waiting on promises run (the RPC stand-ins resolve on the microtask queue). */
  const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));

  it.effect(
    "renews every 30 s while an account's check runs, and stops once a renewal finds it lost",
    () =>
      Effect.gen(function* () {
        let holds = true;

        // The account's token refresh (`ensureFresh` in `quotaProbeTarget`) does not return.
        const plane = fakePlane({
          targets: async () => ["a.json"],
          renew: () => holds,
          target: () => new Promise<void>(() => undefined),
        });

        const fiber = yield* sweepQuotas("panel", FULL_ACCESS).pipe(
          Effect.provide(mockHttp(() => ({ status: 500 })).layer),
          Effect.provideContext(envContext(plane.fakeEnv)),
          Effect.provideService(WorkerExecutionContext, recordingContext().ctx),
          Effect.forkChild,
        );

        yield* Effect.promise(() => until(() => plane.calls.includes("target")));
        expect(LEASE_RENEW_INTERVAL_MS).toBe(30_000);

        // A slow account (a token refresh can take minutes): the lease is renewed meanwhile.
        const renewals = () => plane.calls.filter((call) => call === "renew").length;

        for (let tick = 1; tick <= 3; tick += 1) {
          yield* settle;
          yield* TestClock.adjust(Duration.millis(LEASE_RENEW_INTERVAL_MS));
          yield* Effect.promise(() => until(() => renewals() === tick));
        }

        expect(plane.calls).toEqual(["take:panel", "targets", "target", "renew", "renew", "renew"]);

        // Taken over (or deleted): the next renewal fails and the sweep stops instead of running on unguarded.
        holds = false;
        yield* settle;
        yield* TestClock.adjust(Duration.millis(LEASE_RENEW_INTERVAL_MS));
        const result = yield* Fiber.join(fiber);

        assert.deepStrictEqual(result, { kind: "lost", startedAt: 1 });
        expect(plane.calls.slice(-2)).toEqual(["renew", "release:tok"]);
      }).pipe(Effect.provideService(CurrentOrg, GLOBAL_ORG)),
  );
});

// --- contract -----------------------------------------------------------------------------------------------------

/** `fetch` that answers through the harness (an admin's Access token is added). */
const fetchVia =
  (target: Harness): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    return await target.call(`${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      ...(request.body === null ? {} : { body: await request.text() }),
    });
  };

const client = HttpApiClient.make(ManagementApi, { baseUrl: "https://commissary.test" });

const through = (target: Harness) =>
  Effect.provide(
    Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetchVia(target))),
  );

describe("batch and checkAllQuotas contract", () => {
  it.effect("decodes per-account results and refusals", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await seed("a.json");
        await seed("broken.json", { access_token: "sk-ant-oat-broken" });
      });
      const api = yield* client;

      const result = yield* api.credentials.batch({
        payload: { action: "disable", names: ["a.json", "ghost.json"] },
      });

      assert.strictEqual(result.action, "disable");
      assert.deepStrictEqual(
        result.results.map((item) => [item.name, item.ok, item.error]),
        [
          ["a.json", true, undefined],
          ["ghost.json", false, "not_found"],
        ],
      );

      const refused = yield* Effect.flip(
        api.credentials.batch({ payload: { action: "delete", names: [] } }),
      );

      assert.instanceOf(refused, ManagementError);
      assert.strictEqual(refused.error, "names is required");

      yield* api.credentials.batch({ payload: { action: "enable", names: ["a.json"] } });
      const sweep = yield* api.credentials.checkAllQuotas();

      assert.deepStrictEqual(
        sweep.results.map((item) => [item.name, item.ok]),
        [
          ["a.json", true],
          ["broken.json", false],
        ],
      );
      assert.strictEqual(sweep.checked, 1);

      const held = yield* Effect.promise(() => takeLease("cron"));

      const running = yield* Effect.flip(api.credentials.checkAllQuotas());

      assert.instanceOf(running, ManagementError);
      assert.strictEqual(running.error, "quota_check_running");
      assert.isString(running.message);

      if (held.ok)
        yield* Effect.promise(() =>
          controlPlane().models().releaseQuotaSweepLease(held.lease.token),
        );
    }).pipe(through(harness)),
  );
});
