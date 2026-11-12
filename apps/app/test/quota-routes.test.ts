// `POST /v9/management/credentials/quota`: the Worker probes the provider usage endpoint with the credential's token
// (mocked outbound HTTP) and the ControlPlane stores the report shown in the credential list.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { afterAll, beforeEach, expect } from "vite-plus/test";
import { ManagementApi } from "@commissary/contract/api";
import { CredentialEntry, type QuotaReport } from "@commissary/contract/credentials";
import { ManagementError } from "@commissary/contract/errors";
import {
  claudeFile,
  controlPlane,
  type Harness,
  jsonInit,
  makeHarness,
  resetControlPlane,
} from "./support/management.ts";
import { env } from "cloudflare:workers";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { envContext } from "../src/worker-env.ts";
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  FULL_ACCESS,
  mockHttp,
  type MockReply,
  RESET_GRANT_STATUS_URL,
  routes,
  runQuotaSweep,
} from "@commissary/models/testing";

const QUOTA = "/v9/management/credentials/quota";

const USAGE = {
  five_hour: { utilization: 12, resets_at: "2026-10-10T15:00:00Z" },
  seven_day: { utilization: 40, resets_at: "2026-10-14T00:00:00Z" },
};

/** The current test's answer of the Claude usage endpoint (the profile always answers Max). */
let usageReply: MockReply = { status: 200, body: USAGE };

const harness = makeHarness(
  routes({
    [`GET ${CLAUDE_USAGE_URL}`]: () => usageReply,
    [`GET ${CLAUDE_PROFILE_URL}`]: { status: 200, body: { account: { has_claude_max: true } } },
    // Reset grants are covered by reset-grants.test.ts; their failure is tolerated here.
    [`GET ${RESET_GRANT_STATUS_URL}`]: { status: 404 },
  }),
);

afterAll(async () => {
  await harness.dispose();
});

beforeEach(async () => {
  usageReply = { status: 200, body: USAGE };
  harness.requests.length = 0;
  await resetControlPlane();
});

const seedClaude = async (name = "claude-a.json"): Promise<void> => {
  const result = await controlPlane()
    .models()
    .importAuthFile(name, JSON.stringify(claudeFile()), {}, FULL_ACCESS);

  expect(result.ok).toBe(true);
};

const check = (name: string) => harness.json(QUOTA, jsonInit("POST", { name }));

const decodeListed = Schema.decodeUnknownSync(
  Schema.Struct({ files: Schema.Array(CredentialEntry) }),
);

/** The `quota_report` of `name` in `GET /credentials`, decoded with the contract. */
const listedReport = async (name: string): Promise<QuotaReport | undefined> => {
  const { body } = await harness.json("/v9/management/credentials");

  return decodeListed(body).files.find((file) => file.name === name)?.quota_report;
};

describe("POST /credentials/quota", () => {
  it("probes the usage endpoint with the credential's token and stores the report", async () => {
    await seedClaude();
    const { status, body } = await check("claude-a.json");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      report: {
        plan: "max",
        windows: [
          {
            id: "five_hour",
            label: "5-hour",
            used_percent: 12,
            resets_at: "2026-10-10T15:00:00.000Z",
            window_seconds: 18_000,
          },
          { id: "seven_day", label: "Weekly", used_percent: 40, window_seconds: 604_800 },
        ],
      },
    });

    // SAFETY: matched above.
    const report = (body as { report: Record<string, unknown> }).report;
    expect(report.checked_at).toBe(report.refreshed_at);
    expect(report.error).toBeUndefined();

    const usage = harness.requests.find((request) => request.url === CLAUDE_USAGE_URL);
    expect(usage?.headers.authorization).toBe("Bearer sk-ant-oat-secret-access");
    expect(usage?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");

    expect(await listedReport("claude-a.json")).toEqual(report);
  });

  it("an upstream failure is a 200 that keeps the last windows and carries the error", async () => {
    await seedClaude();
    const first = await check("claude-a.json");
    usageReply = { status: 500, body: { error: "secret-bearing upstream body" } };
    const { status, body } = await check("claude-a.json");

    expect(status).toBe(200);
    // SAFETY: both answers are `{status, report}` objects (checked by status).
    const before = (first.body as { report: Record<string, unknown> }).report;
    const after = (body as { report: Record<string, unknown> }).report;

    expect(after).toMatchObject({
      refreshed_at: before.refreshed_at,
      plan: "max",
      windows: before.windows,
      error: "usage endpoint answered 500",
    });
    expect(JSON.stringify(after)).not.toContain("secret");
    expect(await listedReport("claude-a.json")).toEqual(after);
  });

  it("a transport failure is recorded too", async () => {
    await seedClaude();
    usageReply = { transportError: true };
    const { status, body } = await check("claude-a.json");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      report: { windows: [], error: "usage request failed" },
    });
  });

  it("answers 404 for an unknown file and 400 without a name", async () => {
    const missing = await check("ghost.json");

    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "auth file not found" });

    const unnamed = await harness.json(QUOTA, jsonInit("POST", {}));

    expect(unnamed.status).toBe(400);
    expect(unnamed.body).toEqual({ error: "name is required" });
  });

  it("answers 422 for a provider without a usage endpoint, without calling upstream", async () => {
    const imported = await controlPlane()
      .models()
      .importAuthFile(
        "qwen-a.json",
        JSON.stringify({
          type: "qwen",
          email: "q@x.com",
          access_token: "ya29.secret",
          refresh_token: "r",
          expired: "2999-01-01T00:00:00Z",
        }),
        {},
        FULL_ACCESS,
      );

    expect(imported.ok).toBe(true);
    const { status, body } = await check("qwen-a.json");

    expect(status).toBe(422);
    expect(body).toEqual({ error: "quota check is not supported for qwen" });
    expect(harness.requests).toHaveLength(0);
  });

  it("drops the report when a re-login replaces the tokens and when the file is removed", async () => {
    await seedClaude();
    await check("claude-a.json");
    expect(await listedReport("claude-a.json")).toBeDefined();

    await controlPlane()
      .models()
      .importAuthFile(
        "claude-a.json",
        JSON.stringify(claudeFile({ access_token: "sk-ant-oat-other-account" })),
        {},
        FULL_ACCESS,
      );

    expect(await listedReport("claude-a.json")).toBeUndefined();

    await check("claude-a.json");
    await controlPlane().models().removeCredential("claude-a.json", FULL_ACCESS);
    await seedClaude();

    expect(await listedReport("claude-a.json")).toBeUndefined();
  });
});

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

describe("checkQuota contract", () => {
  it.effect("decodes the report and the credential entry's quota_report", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedClaude());
      const api = yield* client;
      const answer = yield* api.credentials.checkQuota({ payload: { name: "claude-a.json" } });

      assert.strictEqual(answer.status, "ok");
      assert.deepStrictEqual(
        answer.report.windows.map((window) => [window.id, window.used_percent]),
        [
          ["five_hour", 12],
          ["seven_day", 40],
        ],
      );

      const { files } = yield* api.credentials.list();

      assert.deepStrictEqual(files[0]?.quota_report, answer.report);
    }).pipe(through(harness)),
  );

  it.effect("decodes 404 and 422 into ManagementError", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await controlPlane()
          .models()
          .importAuthFile(
            "qwen-a.json",
            JSON.stringify({ type: "qwen", access_token: "t", expired: "2999-01-01T00:00:00Z" }),
            {},
            FULL_ACCESS,
          );
      });
      const api = yield* client;

      const missing = yield* Effect.flip(
        api.credentials.checkQuota({ payload: { name: "ghost.json" } }),
      );

      assert.instanceOf(missing, ManagementError);
      assert.strictEqual(missing.error, "auth file not found");

      const unsupported = yield* Effect.flip(
        api.credentials.checkQuota({ payload: { name: "qwen-a.json" } }),
      );

      assert.instanceOf(unsupported, ManagementError);
      assert.strictEqual(unsupported.error, "quota check is not supported for qwen");
    }).pipe(through(harness)),
  );
});

describe("quota-check cron task", () => {
  it.effect("checks every enabled auth file of a supported provider", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await seedClaude("claude-a.json");
        await controlPlane()
          .models()
          .importAuthFile(
            "claude-off.json",
            JSON.stringify(claudeFile({ disabled: true })),
            {},
            FULL_ACCESS,
          );
        await controlPlane()
          .models()
          .importAuthFile(
            "qwen-a.json",
            JSON.stringify({ type: "qwen", access_token: "t", expired: "2999-01-01T00:00:00Z" }),
            {},
            FULL_ACCESS,
          );
      });

      const outbound = mockHttp(
        routes({
          [`GET ${CLAUDE_USAGE_URL}`]: { status: 200, body: USAGE },
          [`GET ${CLAUDE_PROFILE_URL}`]: { status: 401 },
          [`GET ${RESET_GRANT_STATUS_URL}`]: { status: 401 },
        }),
      );

      const summary = yield* runQuotaSweep.pipe(
        Effect.provide(outbound.layer),
        Effect.provideContext(envContext(env)),
      );

      assert.deepStrictEqual(summary, { checked: 1, failed: 0 });
      assert.deepStrictEqual(outbound.requests.map((request) => request.url).toSorted(), [
        CLAUDE_PROFILE_URL,
        CLAUDE_USAGE_URL,
        RESET_GRANT_STATUS_URL,
      ]);

      const report = yield* Effect.promise(() => listedReport("claude-a.json"));

      assert.isDefined(report);
      assert.isUndefined(yield* Effect.promise(() => listedReport("claude-off.json")));
    }).pipe(Effect.provideService(CurrentOrg, GLOBAL_ORG)),
  );
});
