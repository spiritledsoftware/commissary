// OpenCode Go keys on the Accounts page: `GET /credentials` lists the config keys whose provider reports quota (named
// by their auth_index, the key masked), the quota check and the cron sweep probe `{base}/usage` with the key (mocked
// outbound HTTP), the file-only operations refuse them with `409 config_credential`, and an edited key starts afresh.
import { assert, describe, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { afterAll, beforeEach, expect } from "vitest";
import { CredentialEntry } from "@commissary/contract/credentials";
import {
  controlPlane,
  jsonInit,
  makeHarness,
  resetControlPlane,
  SERVICE_ADMIN,
  SERVICE_ADMIN_BINDINGS,
  serviceToken,
} from "./support/management.ts";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { envContext } from "../src/worker-env.ts";
import {
  FULL_ACCESS,
  mockHttp,
  type MockReply,
  routes,
  runQuotaSweep,
} from "@commissary/models/testing";

const GO_KEY = "sk-go-routes-0001";

const GO_OFF_KEY = "sk-go-routes-0002";

const ZEN_KEY = "sk-zen-routes-0003";

const CODEX_KEY = "sk-codex-routes-0004";

const GO_EDITED_KEY = "sk-go-routes-0005";

const USAGE_URL = "https://opencode.ai/inference/go/v1/usage";

const SECRETS = [GO_KEY, GO_OFF_KEY, ZEN_KEY, CODEX_KEY, GO_EDITED_KEY];

const CONFIG = `
codex-api-key:
  - api-key: ${CODEX_KEY}
api-keys:
  opencode-zen:
    - keys:
        - api-key: ${ZEN_KEY}
  opencode-go:
    - keys:
        - api-key: ${GO_KEY}
    - keys:
        - api-key: ${GO_OFF_KEY}
          excluded-models: ["*"]
`;

const USAGE = {
  usage: {
    rolling: { status: "ok", percent: 12, resetsAt: "2026-10-12T14:28:13.000Z" },
    weekly: { status: "ok", percent: 40, resetsAt: "2026-10-19T00:00:00.000Z" },
    monthly: { status: "ok", percent: 3, resetsAt: "2026-11-05T10:59:17.000Z" },
  },
};

let usageReply: MockReply = { status: 200, body: USAGE };

const harness = makeHarness(
  routes({ [`GET ${USAGE_URL}`]: () => usageReply }),
  SERVICE_ADMIN_BINDINGS,
);

afterAll(async () => {
  await harness.dispose();
});

beforeEach(async () => {
  usageReply = { status: 200, body: USAGE };
  harness.requests.length = 0;
  await resetControlPlane();
  const stored = await controlPlane().models().importConfig(CONFIG, "test");
  expect(stored.ok).toBe(true);
});

const decodeListed = Schema.decodeUnknownSync(
  Schema.Struct({ files: Schema.Array(CredentialEntry) }),
);

const listed = async () => {
  const response = await harness.call("/v9/management/credentials");
  const text = await response.text();

  expect(response.status).toBe(200);

  // The panel lists accounts by `auth_index` (an HMAC of the test key); put them in config order for the assertions.
  const files = decodeListed(JSON.parse(text)).files.toSorted(
    (a, b) => (a.key_group?.index ?? 0) - (b.key_group?.index ?? 0),
  );

  return { text, files };
};

/** The credential ids with a stored quota report (the ControlPlane's `credential_quota_report` rows). */
const reportRows = () =>
  runInDurableObject(controlPlane(), (_instance, state) =>
    state.storage.sql
      .exec<{ id: string }>("SELECT id FROM credential_quota_report ORDER BY id")
      .toArray()
      .map((row) => row.id),
  );

const checkQuota = (name: string) =>
  harness.json("/v9/management/credentials/quota", jsonInit("POST", { name }));

/** The listed OpenCode Go accounts: the enabled key first (config order). */
const goAccounts = async () =>
  (await listed()).files.filter((file) => file.provider === "opencode-go");

describe("GET /credentials with OpenCode Go keys", () => {
  it("lists the OpenCode Go keys as config accounts, and no other config key, without a secret", async () => {
    const { text, files } = await listed();

    expect(files.map((file) => [file.provider, file.source])).toEqual([
      ["opencode-go", "config"],
      ["opencode-go", "config"],
    ]);

    const [on, off] = files;

    expect(on).toMatchObject({
      name: on?.auth_index,
      id: on?.auth_index,
      supports_quota: true,
      disabled: false,
      account: "[redacted]…0001",
      key_group: { family: "opencode-go", index: 0 },
    });
    expect(off).toMatchObject({ disabled: true, key_group: { family: "opencode-go", index: 1 } });

    for (const secret of SECRETS) expect(text).not.toContain(secret);
    // The content-addressed credential ids are never sent either.
    expect(text).not.toContain(":apikey:");
  });
});

describe("POST /credentials/quota for an OpenCode Go key", () => {
  it("probes {base}/usage with the key and stores the three windows", async () => {
    const [account] = await goAccounts();

    const { status, body } = await harness.json(
      "/v9/management/credentials/quota",
      jsonInit("POST", { name: account?.auth_index ?? "" }),
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      report: {
        windows: [
          { id: "five_hour", label: "5-hour", used_percent: 12 },
          { id: "weekly", label: "Weekly", used_percent: 40 },
          { id: "monthly", label: "Monthly", used_percent: 3 },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain(GO_KEY);

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      method: "GET",
      url: USAGE_URL,
      redirect: "manual",
      headers: { authorization: `Bearer ${GO_KEY}` },
    });

    const [after] = await goAccounts();

    expect(after?.quota_report?.windows).toHaveLength(3);
  });

  it("records a refused key as a failed check", async () => {
    usageReply = {
      status: 401,
      body: { type: "error", error: { type: "AuthError", message: "Unauthorized" } },
    };

    const [account] = await goAccounts();

    const { status, body } = await harness.json(
      "/v9/management/credentials/quota",
      jsonInit("POST", { name: account?.auth_index ?? "" }),
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({ report: { error: expect.any(String) } });
  });

  it("answers 404 for the raw credential id and for other config keys", async () => {
    const ids = (await controlPlane().models().listCredentials(FULL_ACCESS)).map(
      (entry) => entry.id,
    );

    expect(ids.length).toBeGreaterThan(0);

    for (const name of ids) {
      const { status } = await harness.json(
        "/v9/management/credentials/quota",
        jsonInit("POST", { name }),
      );

      expect(status).toBe(404);
    }

    expect(harness.requests).toHaveLength(0);
  });
});

describe("POST /credentials/quota/all with OpenCode Go keys", () => {
  it("checks the enabled OpenCode Go key under its auth_index", async () => {
    const [on] = await goAccounts();

    const { status, body } = await harness.json(
      "/v9/management/credentials/quota/all",
      jsonInit("POST", {}),
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      results: [{ name: on?.auth_index, ok: true }],
      checked: 1,
      failed: 0,
    });
    expect(harness.requests.map((request) => request.url)).toEqual([USAGE_URL]);
    expect((await goAccounts())[0]?.quota_report?.windows).toHaveLength(3);
  });
});

describe("an edited OpenCode Go key", () => {
  it("is a new account: the old auth_index is gone, no report carries over, the sweep drops the old row", async () => {
    const [before] = await goAccounts();
    const oldIndex = before?.auth_index ?? "";

    expect((await checkQuota(oldIndex)).status).toBe(200);
    expect(await reportRows()).toHaveLength(1);

    const stored = await controlPlane()
      .models()
      .importConfig(CONFIG.replace(GO_KEY, GO_EDITED_KEY), "test");

    expect(stored.ok).toBe(true);

    expect((await checkQuota(oldIndex)).status).toBe(404);

    const [after] = await goAccounts();

    expect(after?.account).toBe("[redacted]…0005");
    expect(after?.auth_index).not.toBe(oldIndex);
    expect(after?.quota_report).toBeUndefined();

    const summary = await Effect.runPromise(
      runQuotaSweep.pipe(
        Effect.provide(
          mockHttp(routes({ [`GET ${USAGE_URL}`]: { status: 200, body: USAGE } })).layer,
        ),
        Effect.provideContext(envContext(env)),
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
      ),
    );

    expect(summary).toEqual({ checked: 1, failed: 0 });

    const ids = (await controlPlane().models().listCredentials(FULL_ACCESS)).map(
      (entry) => entry.id,
    );

    const rows = await reportRows();

    expect(rows).toHaveLength(1);
    expect(ids).toContain(rows[0]);
    expect((await goAccounts())[0]?.quota_report?.windows).toHaveLength(3);
  });
});

describe("file-only operations on an OpenCode Go key", () => {
  it("answer 409 config_credential", async () => {
    const [account] = await goAccounts();
    const name = account?.auth_index ?? "";
    const query = `name=${encodeURIComponent(name)}`;

    const answers = [
      await harness.json(`/v9/management/credentials?${query}`, { method: "DELETE" }),
      await harness.json(`/v9/management/credentials/download?${query}`, {
        auth: await serviceToken(SERVICE_ADMIN),
      }),
      await harness.json(
        "/v9/management/credentials/fields",
        jsonInit("PATCH", { name, note: "hello" }),
      ),
      await harness.json("/v9/management/credentials/refresh", jsonInit("POST", { name })),
      await harness.json(
        "/v9/management/credentials/status",
        jsonInit("PATCH", { name, disabled: true }),
      ),
    ];

    for (const answer of answers)
      expect(answer).toMatchObject({ status: 409, body: { error: "config_credential" } });

    for (const action of ["enable", "disable", "refresh", "delete"]) {
      const { status, body } = await harness.json(
        "/v9/management/credentials/batch",
        jsonInit("POST", { action, names: [name] }),
      );

      expect(status).toBe(200);
      expect(JSON.stringify(body)).toContain('"error":"config_credential"');
    }

    const several = await harness.json(`/v9/management/credentials?${query}&name=missing.json`, {
      method: "DELETE",
    });

    expect(several).toMatchObject({
      status: 207,
      body: {
        failed: [
          { name, error: "config_credential" },
          { name: "missing.json", error: "auth file not found" },
        ],
      },
    });

    // Still listed, untouched.
    const accounts = await goAccounts();

    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.disabled).toBe(false);
  });
});

describe("quota-check cron task with OpenCode Go keys", () => {
  it.effect("checks the enabled OpenCode Go key only", () =>
    Effect.gen(function* () {
      const outbound = mockHttp(routes({ [`GET ${USAGE_URL}`]: { status: 200, body: USAGE } }));

      const summary = yield* runQuotaSweep.pipe(
        Effect.provide(outbound.layer),
        Effect.provideContext(envContext(env)),
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
      );

      assert.deepStrictEqual(summary, { checked: 1, failed: 0 });
      assert.deepStrictEqual(
        outbound.requests.map((request) => request.headers["authorization"]),
        [`Bearer ${GO_KEY}`],
      );

      const [on, off] = yield* Effect.promise(goAccounts);

      assert.strictEqual(on?.quota_report?.windows.length, 3);
      assert.isUndefined(off?.quota_report);
    }),
  );
});
