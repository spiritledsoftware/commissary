// /v9/management/settings through the router, Access gate and real ControlPlane: the Settings page's view and writes.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Json } from "@commissary/json";
import type { SettingsView } from "@commissary/contract/settings";
import {
  controlPlane,
  jsonInit,
  makeHarness,
  resetControlPlane,
  token,
} from "./support/management.ts";

const harness = makeHarness();

afterAll(harness.dispose);

beforeEach(resetControlPlane);

const { call, json } = harness;

const PATH = "/v9/management/settings";

const SECRETS = {
  key: "sk-ant-SETTINGS-SECRET-4242",
  proxy: "http://user:proxy-pass-777@commissary.test:8080",
  groupProxy: "http://group-user:group-pass-555@commissary.test:9090",
  client: "client-key-SECRET-1313",
};

const seed = async (document: Record<string, unknown>): Promise<number> => {
  const result = await controlPlane().models().importConfig(JSON.stringify(document), "test");

  if (!result.ok) throw new Error(result.message);

  return result.version;
};

const getView = async (): Promise<SettingsView> => {
  const response = await json(PATH);

  expect(response.status).toBe(200);

  // SAFETY: the shape is checked against the contract in management-contract.test.ts.
  return response.body as SettingsView;
};

/** Saves `patch` at `revisions` (by default the revisions of a fresh view). */
const save = async (patch: Json, revisions?: Readonly<Record<string, number>>) =>
  await json(
    PATH,
    jsonInit("PATCH", { revisions: revisions ?? (await getView()).revisions, patch }),
  );

const storedDocument = async (): Promise<Record<string, unknown>> => {
  const wire = await controlPlane().models().getConfig();

  // SAFETY: the stored config document is a serialized JSON object.
  return JSON.parse(wire.document ?? "{}") as Record<string, unknown>;
};

/** The ids of the stored settings (a setting at its default is not stored). */
const storedSettings = async (): Promise<ReadonlyArray<string>> =>
  Object.keys((await controlPlane().models().configEntries()).revisions.settings).toSorted();

describe("management settings", () => {
  it("requires an Access admin", async () => {
    expect((await call(PATH, { auth: false })).status).toBe(401);
    expect((await call(PATH, { auth: await token("other@example.com") })).status).toBe(403);
  });

  it("serves the defaults on an empty config", async () => {
    const view = await getView();

    expect(view.values).toEqual(view.defaults);
    expect(view.values.routing.strategy).toBe("round-robin");
    expect(view.values.routing["session-affinity-ttl"]).toBe("1h");
    expect(view.values.upstream.claude["cloak-level"]).toBe("full");
    expect(view.values.oauth.providers.antigravity["signature-cache-enabled"]).toBeNull();
    expect(view.revisions).toEqual({});
    expect(view.payload).toEqual({
      default: 0,
      "default-raw": 0,
      override: 0,
      "override-raw": 0,
      filter: 0,
    });
    expect(view.prefixed_credentials).toBe(0);
    expect(view.request_scoped_errors).toEqual({});
    expect(view.version).toBeGreaterThanOrEqual(0);
  });

  it("never serves a secret", async () => {
    await seed({
      access: { "api-keys": [SECRETS.client] },
      requests: {
        "proxy-url": SECRETS.proxy,
        payload: { default: [{ models: [{ name: "gpt-*" }], params: { temperature: 0 } }] },
      },
      upstream: { codex: { "response-steering": true } },
      observability: { logs: { debug: true } },
      oauth: {
        "request-scoped-errors": {
          claude: [{ status: 400, match: ["overloaded"], action: "continue" }],
        },
      },
      "api-keys": {
        claude: [
          {
            name: "main",
            prefix: "team",
            "base-url": "https://api.anthropic.com",
            "proxy-url": SECRETS.groupProxy,
            keys: [{ "api-key": SECRETS.key }],
          },
        ],
      },
    });

    const response = await call(PATH);
    const text = await response.text();

    expect(response.status).toBe(200);

    for (const secret of [...Object.values(SECRETS), "proxy-pass", "group-pass"])
      expect(text).not.toContain(secret);

    // SAFETY: a 200 body of this route is a SettingsView (checked by the contract test).
    const view = JSON.parse(text) as SettingsView;

    // The keys that do nothing on Workers are not imported, so the view has nothing to say about them.
    expect(view).not.toHaveProperty("not_applied");
    // Response steering is effective on Workers: a value, not an inert key.
    expect(view.values.upstream.codex["response-steering"]).toBe(true);
    expect(view.payload.default).toBe(1);
    expect(view.prefixed_credentials).toBe(1);
    expect(view.request_scoped_errors).toEqual({
      claude: [{ status: 400, match: ["overloaded"], "match-regexr": [], action: "continue" }],
    });
    expect(view.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes one leaf and leaves everything else as stored", async () => {
    const version = await seed({
      "api-keys": {
        claude: [{ "base-url": "https://api.anthropic.com", keys: [{ "api-key": SECRETS.key }] }],
      },
      oauth: { "model-alias": { claude: [{ name: "claude-opus-4-6", alias: "opus" }] } },
    });

    const before = await storedDocument();
    const saved = await save({ routing: { "session-affinity-ttl": "30m" } });

    expect(saved).toMatchObject({
      status: 200,
      body: {
        status: "ok",
        version: version + 1,
        revisions: { "routing.session-affinity-ttl": version + 1 },
      },
    });

    const view = await getView();

    expect(view.version).toBe(version + 1);
    expect(view.revisions).toEqual({ "routing.session-affinity-ttl": version + 1 });
    expect(view.values.routing["session-affinity-ttl"]).toBe("30m");
    expect({ ...view.values, routing: view.defaults.routing }).toEqual(view.defaults);

    const after = await storedDocument();

    expect(JSON.stringify(after["api-keys"])).toBe(JSON.stringify(before["api-keys"]));
    expect(after.oauth).toEqual(before.oauth);
  });

  it("resets a leaf to its default with null", async () => {
    await seed({
      routing: { strategy: "fill-first" },
      oauth: { providers: { antigravity: { "signature-cache-enabled": false } } },
    });

    expect(await storedSettings()).toEqual([
      "oauth.providers.antigravity.signature-cache-enabled",
      "routing.strategy",
    ]);

    const saved = await save({
      routing: { strategy: null },
      oauth: { providers: { antigravity: { "signature-cache-enabled": null } } },
    });

    expect(saved.status).toBe(200);
    const view = await getView();

    expect(view.values).toEqual(view.defaults);
    // A setting at its default is not stored: it has no revision.
    expect(await storedSettings()).toEqual([]);
    expect(view.revisions).toEqual({});
  });

  it("refuses the keys that do nothing on Workers as not settings", async () => {
    for (const [patch, path] of [
      // No setting lives under `access`: the admin lists are an org's members now (`/v9/management/members`).
      [{ access: { "api-keys": ["other"] } }, "access"],
      [{ access: { "api-keys": null } }, "access"],
      [{ access: { "admin-emails": ["new@example.com"] } }, "access"],
      [{ access: { "admin-service-tokens": ["new.access"] } }, "access"],
      [
        { observability: { usage: { "redis-usage-queue-retention-seconds": 120 } } },
        // No setting lives under `observability`.
        "observability",
      ],
    ] satisfies ReadonlyArray<readonly [Json, string]>) {
      expect(await save(patch)).toMatchObject({
        status: 400,
        body: { error: "not_a_setting", path },
      });
    }
  });

  it("refuses a stale revision without storing or retrying; other settings never conflict", async () => {
    const version = await seed({ routing: { strategy: "fill-first" } });
    const { revisions } = await getView();

    expect((await save({ routing: { strategy: "weighted-round-robin" } }, revisions)).status).toBe(
      200,
    );
    // Another setting saved from the same view.
    expect((await save({ routing: { "session-affinity": true } }, revisions)).status).toBe(200);

    const stale = await save({ routing: { strategy: "round-robin" } }, revisions);

    expect(stale).toMatchObject({ status: 409, body: { error: "conflict" } });
    const view = await getView();

    expect(view.version).toBe(version + 2);
    expect(view.values.routing.strategy).toBe("weighted-round-robin");
  });

  it("answers 400 not_a_setting for paths that are not settings", async () => {
    const { version } = await getView();

    const cases: ReadonlyArray<readonly [Json, string]> = [
      [{ "api-keys": { claude: [] } }, "api-keys"],
      [{ routing: { bogus: 1 } }, "routing.bogus"],
      [{ oauth: { "model-alias": {} } }, "oauth.model-alias"],
      [{ requests: { payload: {} } }, "requests.payload"],
      [{ upstream: { codex: { "response-steering": true, nope: false } } }, "upstream.codex.nope"],
    ];

    for (const [patch, path] of cases) {
      expect(await save(patch)).toMatchObject({
        status: 400,
        body: { error: "not_a_setting", path },
      });
    }

    expect((await getView()).version).toBe(version);
  });

  it("answers 422 invalid_setting with the path and stores nothing", async () => {
    const { version } = await getView();

    const cases: ReadonlyArray<readonly [Json, string]> = [
      [{ routing: { "session-affinity-ttl": "soon" } }, "routing.session-affinity-ttl"],
      [{ routing: { "session-affinity-ttl": "0s" } }, "routing.session-affinity-ttl"],
      [{ routing: { strategy: "wrr2" } }, "routing.strategy"],
      [{ routing: { strategy: "wrr" } }, "routing.strategy"],
      [
        { routing: { retry: { "max-retry-credentials": -1 } } },
        "routing.retry.max-retry-credentials",
      ],
      [{ routing: { retry: { "request-retry": 1.5 } } }, "routing.retry.request-retry"],
      [{ routing: { "session-affinity": "yes" } }, "routing.session-affinity"],
      [{ routing: "fill-first" }, "routing"],
      [{ multimedia: { "gpt-image-2-base-model": "dall-e" } }, "multimedia.gpt-image-2-base-model"],
      [{ multimedia: { "disable-image-generation": "on" } }, "multimedia.disable-image-generation"],
      [{ upstream: { claude: { "cloak-level": "off" } } }, "upstream.claude.cloak-level"],
      [
        { multimedia: { "video-result-auth-cache-ttl": "3" } },
        "multimedia.video-result-auth-cache-ttl",
      ],
      [{ models: { catalog: "ftp://catalog.test/models.json" } }, "models.catalog"],
      [
        { upstream: { codex: { "stream-bootstrap-timeout": "later" } } },
        "upstream.codex.stream-bootstrap-timeout",
      ],
      [
        { upstream: { claude: { "header-defaults": { timezone: "Mars/Olympus" } } } },
        "upstream.claude.header-defaults.timezone",
      ],
      // Valid but rewritten by the normaliser (trimmed / lower-cased): refused by the survival check.
      [
        { upstream: { claude: { "header-defaults": { "user-agent": " claude-cli " } } } },
        "upstream.claude.header-defaults.user-agent",
      ],
    ];

    for (const [patch, path] of cases) {
      const refused = await save(patch);

      expect(refused, JSON.stringify(patch)).toMatchObject({
        status: 422,
        body: { error: "invalid_setting", path, message: expect.any(String) },
      });
    }

    expect((await getView()).version).toBe(version);
  });

  it("accepts the documented special values", async () => {
    for (const patch of [
      { upstream: { codex: { "stream-bootstrap-timeout": "unlimited" } } },
      { upstream: { codex: { "stream-bootstrap-timeout": "90" } } },
      { upstream: { claude: { "header-defaults": { timezone: "Local" } } } },
      { upstream: { claude: { "header-defaults": { timezone: "Europe/Berlin" } } } },
      { models: { catalog: "https://example.test/models.json" } },
      { models: { catalog: "embed" } },
      {
        multimedia: { "disable-image-generation": "chat", "gpt-image-2-base-model": "gpt-image-x" },
      },
      { routing: { cooldown: { "transient-error-cooldown-seconds": -1 } } },
      { upstream: { claude: { "cloak-level": "minimal" } } },
    ] satisfies Json[]) {
      const saved = await save(patch);

      expect(saved.status, JSON.stringify(patch)).toBe(200);
    }

    const view = await getView();

    expect(view.values.models.catalog).toBe("embed");
    expect(view.values.multimedia["disable-image-generation"]).toBe("chat");
    expect(view.values.routing.cooldown["transient-error-cooldown-seconds"]).toBe(-1);
    expect(view.values.upstream.claude["cloak-level"]).toBe("minimal");
  });

  it("refuses bodies without revisions or patch object", async () => {
    expect(await json(PATH, jsonInit("PATCH", { patch: {} }))).toMatchObject({
      status: 400,
      body: { error: "invalid body" },
    });
    expect(await json(PATH, jsonInit("PATCH", { revisions: {}, patch: [] }))).toMatchObject({
      status: 400,
    });
    expect(
      await json(PATH, jsonInit("PATCH", { revisions: { "routing.strategy": -1 }, patch: {} })),
    ).toMatchObject({ status: 400 });
  });
});
