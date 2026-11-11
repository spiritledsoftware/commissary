// Config entries (ADR 0025): per-entry revisions, the Go config import, the migration of a stored document, and the
// entry routes (`/settings`, `/provider-keys/groups`, `/model-rules/*`) through the router and the real ControlPlane.
import { runInDurableObject } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { Json } from "@commissary/json";
import type { ProviderKeysList } from "@commissary/contract/provider-keys";
import type { RoutingModels } from "@commissary/contract/routing";
import type { SettingsView } from "@commissary/contract/settings";
import { OrgId } from "@commissary/core";
import { controlPlane, jsonInit, makeHarness, resetControlPlane } from "./support/management.ts";
import {
  asBeforeEncryption,
  authIndexOf,
  comparable,
  configKeyIds,
  decodeConfig,
  encodeConfig,
  FULL_ACCESS,
  MIGRATION_PRINCIPAL,
} from "@commissary/models/testing";

const harness = makeHarness();

afterAll(harness.dispose);

beforeEach(resetControlPlane);

const { json } = harness;

/** `value`, failing the test when it is missing. */
const must = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("expected a value");

  return value;
};

const decoded = (document: string | undefined) =>
  Effect.runSync(decodeConfig(JSON.parse(document ?? "{}") as Json));

const current = async () => decoded((await controlPlane().models().getConfig()).document);

// A Go config document with a bit of everything: v8 key groups with ids to derive, a disabled OpenAI-compatible
// endpoint, a key-less one, model rules, payload rules, settings and keys that do nothing on Workers.
const DOCUMENT = {
  routing: {
    strategy: "fill-first",
    "session-affinity": true,
    cooldown: { "save-cooldown-status": true },
  },
  access: { "api-keys": ["client-key"], "admin-emails": ["ops@example.com"] },
  requests: {
    "proxy-url": "http://commissary.test:8080",
    payload: {
      default: [{ models: [{ name: "gpt-*" }], params: { "reasoning.effort": "high" } }],
      filter: [{ models: [{ name: "claude-*" }], params: ["metadata"] }],
    },
  },
  oauth: {
    "model-alias": { claude: [{ name: "claude-opus-4-1", alias: "opus" }] },
    "excluded-models": { codex: ["gpt-5-nano"] },
  },
  "api-keys": {
    claude: [
      {
        "base-url": "https://api.anthropic.com",
        keys: [
          { "api-key": "sk-ant-one", "experimental-cch-signing": true },
          { "api-key": "sk-ant-two", prefix: "team" },
        ],
      },
      { keys: [{ "api-key": "sk-ant-three", "excluded-models": ["*"] }] },
    ],
    gemini: [{ keys: [{ "api-key": "AIza-one" }] }],
    "openai-compatibility": [
      {
        name: "acme",
        "base-url": "https://api.acme.test/v1",
        disabled: true,
        keys: [{ "api-key": "sk-acme-1" }, { "api-key": "sk-acme-2" }],
      },
      { name: "keyless", "base-url": "https://keyless.test/v1", keys: [] },
    ],
  },
};

describe("config import", () => {
  it("stores the same config as decoding the document and names the not-applied keys", async () => {
    const before = Effect.runSync(decodeConfig(DOCUMENT as unknown as Json));
    const result = await controlPlane().models().importConfig(JSON.stringify(DOCUMENT), "test");

    expect(result).toMatchObject({ ok: true });
    // Org members and roles replace the config admin lists: an import names them as not applied.
    expect(result.ok && result.notApplied).toEqual([
      "access.api-keys",
      "access.admin-emails",
      "requests.proxy-url",
      "api-keys.claude[].keys[].experimental-cch-signing",
      "routing.cooldown.save-cooldown-status",
    ]);

    const after = await current();
    expect(comparable(after)).toEqual(comparable(before));
    // Every provider key keeps the id of the credential it produced (Go's content hash).
    expect(configKeyIds(after)).toEqual(configKeyIds(before));
    expect(configKeyIds(after, { includeDisabledGroups: true })).toEqual(
      configKeyIds(before, { includeDisabledGroups: true }),
    );
  });

  it("refuses an import based on a change counter another write moved, and stores nothing", async () => {
    const { version } = await controlPlane().models().getConfig();

    await controlPlane()
      .models()
      .writeSettings([{ id: "routing.strategy", revision: 0, value: "fill-first" }], "other");

    const result = await controlPlane()
      .models()
      .importConfig("request-retry: 7\n", "test", version);

    expect(result).toMatchObject({ ok: false, error: "conflict" });
    expect((await current()).routing.strategy).toBe("fill-first");
    expect(
      await controlPlane()
        .models()
        .importConfig("request-retry: 7\n", "test", version + 1),
    ).toMatchObject({ ok: true });
  });

  it("refuses an invalid document and keeps the entries", async () => {
    await controlPlane().models().importConfig("routing:\n  strategy: fill-first\n", "test");
    const result = await controlPlane().models().importConfig("routing: [", "test");

    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect((await current()).routing.strategy).toBe("fill-first");
  });

  it("is served at POST /settings/import", async () => {
    const response = await json("/v9/management/settings/import", {
      method: "POST",
      headers: { "content-type": "application/yaml" },
      body: "routing:\n  strategy: fill-first\nrequest-log: true\nclaude-api-key:\n  - api-key: sk-ant-legacy\n",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      not_applied: ["observability.logs.request-log"],
    });
    const config = await current();
    expect(config.routing.strategy).toBe("fill-first");
    expect(config["api-keys"].claude[0]?.keys[0]?.["api-key"]).toBe("sk-ant-legacy");
  });

  it("keeps a document's write-ins as entries of their own", async () => {
    const response = await json("/v9/management/settings/import", {
      method: "POST",
      headers: { "content-type": "application/yaml" },
      body: "models:\n  write-ins:\n    Claude:\n      - { name: claude-fable-5-2, like: claude-fable-5-1 }\n",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", not_applied: [] });
    expect((await current()).models["write-ins"]).toEqual({
      claude: [{ name: "claude-fable-5-2", like: "claude-fable-5-1" }],
    });
  });

  it("answers 422 with the position of a YAML error", async () => {
    const response = await json("/v9/management/settings/import", {
      method: "POST",
      headers: { "content-type": "text/yaml" },
      body: "routing:\n  strategy: [\n",
    });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: "invalid_config" });
  });
});

describe("migration of a stored config document", () => {
  it("imports the document into entries with the same config, credential ids and auth indexes", async () => {
    const org = OrgId.make(`migration-${crypto.randomUUID().slice(0, 8)}`);
    const stub = controlPlane(org);
    const before = Effect.runSync(decodeConfig(DOCUMENT as unknown as Json));
    // What the ControlPlane stored before config entries: the canonical document of the decoded config.
    const document = JSON.stringify(encodeConfig(before));

    // A ControlPlane from before config entries (and before stored secrets were sealed): the document, no data key.
    await asBeforeEncryption(stub, org, (sql) => {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS config (
           id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, document TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         )`,
      );
      sql.exec(
        "INSERT INTO config (id, version, document, updated_at) VALUES (1, 41, ?, 1000)",
        document,
      );
    });

    const snapshot = await stub.models().getConfig();
    // The change counter continues after the document's version, so every cached view is rebuilt.
    expect(snapshot.version).toBe(42);
    const after = decoded(snapshot.document);
    expect(comparable(after)).toEqual(comparable(before));
    expect(configKeyIds(after, { includeDisabledGroups: true })).toEqual(
      configKeyIds(before, { includeDisabledGroups: true }),
    );

    // The pool's config credentials are exactly the same ones, so their auth indexes (an HMAC of the id) are too.
    const expected = Object.values(configKeyIds(before))
      .flatMap((groups) => groups.flatMap((group) => [...group.keys, group.group]))
      .filter((id) => id !== undefined)
      .toSorted((a, b) => a.localeCompare(b));

    const live = (await stub.models().listCredentials(FULL_ACCESS))
      .filter((entry) => entry.source === "config")
      .map((entry) => entry.id)
      .toSorted((a, b) => a.localeCompare(b));

    expect(expected.length).toBeGreaterThan(0);
    expect(live).toEqual(expected);
    expect(live.map(authIndexOf)).toEqual(expected.map(authIndexOf));

    await runInDurableObject(stub, (_instance, state) => {
      // The document row is kept; the entries say who wrote them.
      expect(state.storage.sql.exec("SELECT version FROM config").toArray()).toEqual([
        { version: 41 },
      ]);

      const writers = state.storage.sql
        .exec("SELECT DISTINCT updated_by FROM config_provider_keys")
        .toArray();

      expect(writers).toEqual([{ updated_by: MIGRATION_PRINCIPAL }]);
    });

    // Idempotent: the next start finds the entries and imports nothing again.
    expect((await stub.models().getConfig()).version).toBe(42);
  });

  it("starts empty without a stored document", async () => {
    const stub = controlPlane(OrgId.make(`fresh-${crypto.randomUUID().slice(0, 8)}`));
    const snapshot = await stub.models().getConfig();

    expect(snapshot.version).toBe(0);
    expect(comparable(decoded(snapshot.document))).toEqual(
      comparable(Effect.runSync(decodeConfig({}))),
    );
  });
});

describe("entry revisions", () => {
  it("lets concurrent edits of two different settings both succeed", async () => {
    const [a, b] = await Promise.all([
      controlPlane()
        .models()
        .writeSettings([{ id: "routing.strategy", revision: 0, value: "fill-first" }], "a"),
      controlPlane()
        .models()
        .writeSettings([{ id: "routing.session-affinity", revision: 0, value: true }], "b"),
    ]);

    expect(a.ok && b.ok).toBe(true);
    const config = await current();
    expect(config.routing.strategy).toBe("fill-first");
    expect(config.routing["session-affinity"]).toBe(true);
  });

  it("refuses a stale revision with conflict and stores nothing", async () => {
    const first = await controlPlane()
      .models()
      .writeSettings([{ id: "routing.strategy", revision: 0, value: "fill-first" }], "a");

    expect(first.ok).toBe(true);

    const stale = await controlPlane()
      .models()
      .writeSettings(
        [
          { id: "routing.strategy", revision: 0, value: "round-robin" },
          { id: "routing.session-affinity", revision: 0, value: true },
        ],
        "b",
      );

    expect(stale).toMatchObject({ ok: false, error: "conflict" });
    const config = await current();
    expect(config.routing.strategy).toBe("fill-first");
    // The whole write is refused, also its fresh part.
    expect(config.routing["session-affinity"]).toBe(false);
  });

  it("refuses a write that names a setting twice", async () => {
    const { version } = await controlPlane().models().getConfig();

    const twice = await controlPlane()
      .models()
      .writeSettings(
        [
          { id: "routing.strategy", revision: 0, value: "fill-first" },
          { id: "routing.strategy", revision: 0, value: "round-robin" },
        ],
        "a",
      );

    expect(twice).toMatchObject({ ok: false, error: "invalid" });
    expect((await current()).routing.strategy).toBe("round-robin");
    expect((await controlPlane().models().getConfig()).version).toBe(version);
  });

  it("never repeats a revision for an entry deleted and created again", async () => {
    const created = await controlPlane()
      .models()
      .writeChannelRule("exclusions", "codex", 0, ["a"], "t");

    const removed = await controlPlane()
      .models()
      .writeChannelRule("exclusions", "codex", created.ok ? created.revision : -1, null, "t");

    const again = await controlPlane()
      .models()
      .writeChannelRule("exclusions", "codex", 0, ["b"], "t");

    expect(removed).toMatchObject({ ok: true, revision: 0 });
    expect(again.ok && created.ok && again.revision > created.revision).toBe(true);
  });
});

const SETTINGS = "/v9/management/settings";

const settingsView = async (): Promise<SettingsView> => {
  const response = await json(SETTINGS);

  expect(response.status).toBe(200);

  // SAFETY: the shape is checked against the contract in management-contract.test.ts.
  return response.body as SettingsView;
};

describe("PATCH /settings", () => {
  it("saves edits of different settings made from the same view, and refuses a stale one with 409", async () => {
    const view = await settingsView();
    const revisionOf = (path: string) => view.revisions[path] ?? 0;

    const [a, b] = await Promise.all([
      json(
        SETTINGS,
        jsonInit("PATCH", {
          revisions: { "routing.strategy": revisionOf("routing.strategy") },
          patch: { routing: { strategy: "fill-first" } },
        }),
      ),
      json(
        SETTINGS,
        jsonInit("PATCH", {
          revisions: { "requests.request-retry": 0 },
          patch: { routing: { "session-affinity": true } },
        }),
      ),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    const after = await settingsView();
    expect(after.values.routing.strategy).toBe("fill-first");
    expect(after.values.routing["session-affinity"]).toBe(true);
    expect(after.revisions["routing.strategy"]).toBeGreaterThan(0);

    // A save from the first view, which did not see the strategy change.
    const stale = await json(
      SETTINGS,
      jsonInit("PATCH", {
        revisions: { "routing.strategy": revisionOf("routing.strategy") },
        patch: { routing: { strategy: "round-robin" } },
      }),
    );

    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "conflict" });
    expect((await settingsView()).values.routing.strategy).toBe("fill-first");
  });

  it("answers the new revisions, 0 for a setting reset to its default", async () => {
    const saved = await json(
      SETTINGS,
      jsonInit("PATCH", { revisions: {}, patch: { routing: { strategy: "fill-first" } } }),
    );

    expect(saved.status).toBe(200);

    const revision = (saved.body as { revisions: Record<string, number> }).revisions[
      "routing.strategy"
    ];

    expect(revision).toBeGreaterThan(0);

    const reset = await json(
      SETTINGS,
      jsonInit("PATCH", {
        revisions: { "routing.strategy": must(revision) },
        patch: { routing: { strategy: null } },
      }),
    );

    expect(reset.body).toMatchObject({ status: "ok", revisions: { "routing.strategy": 0 } });
    expect((await settingsView()).revisions["routing.strategy"]).toBeUndefined();
  });
});

const PROVIDER_KEYS = "/v9/management/provider-keys";

const keysList = async (): Promise<ProviderKeysList> => {
  const response = await json(PROVIDER_KEYS);

  expect(response.status).toBe(200);

  // SAFETY: the shape is checked against the contract in management-contract.test.ts.
  return response.body as ProviderKeysList;
};

describe("Provider key groups", () => {
  beforeEach(async () => {
    await controlPlane()
      .models()
      .importConfig(
        JSON.stringify({
          "api-keys": {
            claude: [
              { keys: [{ "api-key": "sk-ant-first-1111" }] },
              { keys: [{ "api-key": "sk-ant-second-2222" }] },
            ],
          },
        }),
        "test",
      );
  });

  it("keeps a key's auth index when its secret changes", async () => {
    const group = must((await keysList()).families.claude[0]);
    const authIndex = must(group.group.keys[0]?.auth_index);

    const credentials = async () =>
      (await controlPlane().models().listCredentials(FULL_ACCESS)).filter(
        (entry) => entry.source === "config",
      );

    const idBefore = (await credentials()).map((entry) => entry.id).toSorted();

    expect(authIndex).toBeDefined();

    const written = await json(
      `${PROVIDER_KEYS}/groups`,
      jsonInit("PUT", {
        family: "claude",
        id: group.id,
        revision: group.revision,
        group: { keys: [{ auth_index: authIndex, "api-key": "sk-ant-rotated-9999" }] },
      }),
    );

    expect(written.status).toBe(200);
    const [after] = (await keysList()).families.claude;
    expect(after?.group.keys[0]?.auth_index).toBe(authIndex);
    expect(after?.group.keys[0]?.key_preview).toContain("9999");
    expect((await credentials()).map((entry) => entry.id).toSorted()).toEqual(idBefore);
    expect(authIndexOf(idBefore[0] ?? "")).toBeDefined();
  });

  it("keeps the auth index of a key edited in the panel when a document with its new secret is imported", async () => {
    const [first, other] = (await keysList()).families.claude;
    const group = must(first);
    const authIndex = must(group.group.keys[0]?.auth_index);
    const otherIndex = must(other?.group.keys[0]?.auth_index);

    const rotated = await json(
      `${PROVIDER_KEYS}/groups`,
      jsonInit("PUT", {
        family: "claude",
        id: group.id,
        revision: group.revision,
        group: { keys: [{ auth_index: authIndex, "api-key": "sk-ant-rotated-9999" }] },
      }),
    );

    expect(rotated.status).toBe(200);

    const imported = await json("/v9/management/settings/import", {
      method: "POST",
      headers: { "content-type": "application/yaml" },
      body: [
        "api-keys:",
        "  claude:",
        "    - keys: [{api-key: sk-ant-second-2222}]",
        "    - keys: [{api-key: sk-ant-rotated-9999}]",
        "",
      ].join("\n"),
    });

    expect(imported.status).toBe(200);
    const [reordered, rotatedGroup] = (await keysList()).families.claude;
    // Its content hash changed with the secret, yet it keeps the id it had, and the other key keeps its own.
    expect(rotatedGroup?.group.keys[0]?.auth_index).toBe(authIndex);
    expect(reordered?.group.keys[0]?.auth_index).toBe(otherIndex);
  });

  it("lets concurrent writes of two different groups both succeed and refuses a stale one with 409", async () => {
    const [first, second] = (await keysList()).families.claude.map(must);

    const write = (group: NonNullable<typeof first>, secret: string) =>
      json(
        `${PROVIDER_KEYS}/groups`,
        jsonInit("PUT", {
          family: "claude",
          id: group.id,
          revision: group.revision,
          group: { keys: [{ auth_index: must(group.group.keys[0]?.auth_index), prefix: secret }] },
        }),
      );

    const [a, b] = await Promise.all([write(must(first), "one"), write(must(second), "two")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const after = (await keysList()).families.claude;
    expect(after.map((group) => group.group.keys[0]?.prefix)).toEqual(["one", "two"]);

    const stale = await write(must(first), "three");
    expect(stale.status).toBe(409);
    expect((await keysList()).families.claude[0]?.group.keys[0]?.prefix).toBe("one");
  });

  it("refuses a group write that would let the normaliser drop a key another group stored since", async () => {
    await controlPlane()
      .models()
      .importConfig(
        JSON.stringify({ "api-keys": { gemini: [{ keys: [{ "api-key": "AIza-first" }] }] } }),
        "test",
      );
    const first = must((await keysList()).families.gemini[0]);

    // Another admin adds a group holding a key; this write was checked against a read without it.
    const added = await controlPlane()
      .models()
      .writeKeyGroup(
        { family: "gemini", revision: 0, group: { keys: [{ "api-key": "AIza-shared" }] } },
        "other",
      );

    expect(added.ok).toBe(true);

    const raced = await controlPlane()
      .models()
      .writeKeyGroup(
        {
          family: "gemini",
          id: first.id,
          revision: first.revision,
          group: { keys: [{ "api-key": "AIza-first" }, { "api-key": "AIza-shared" }] },
        },
        "test",
      );

    expect(raced).toMatchObject({ ok: false, error: "conflict" });
    expect((await keysList()).families.gemini.map((group) => group.group.keys.length)).toEqual([
      1, 1,
    ]);
  });

  it("deletes a group by id and revision", async () => {
    const first = must((await keysList()).families.claude[0]);

    const stale = await json(
      `${PROVIDER_KEYS}/groups`,
      jsonInit("DELETE", { family: "claude", id: first.id, revision: first.revision + 1 }),
    );

    expect(stale.status).toBe(409);

    const removed = await json(
      `${PROVIDER_KEYS}/groups`,
      jsonInit("DELETE", { family: "claude", id: first.id, revision: first.revision }),
    );

    expect(removed.status).toBe(200);
    expect((await keysList()).families.claude).toHaveLength(1);
  });
});

describe("model rules", () => {
  const routing = async (): Promise<RoutingModels> => {
    const response = await json("/v9/management/routing/models");

    expect(response.status).toBe(200);

    // SAFETY: the shape is checked against the contract in management-contract.test.ts.
    return response.body as RoutingModels;
  };

  const put = (kind: string, channel: string, revision: number | string, body: Json) =>
    json(`/v9/management/model-rules/${kind}/${channel}`, {
      ...jsonInit("PUT", body),
      headers: { "content-type": "application/json", "if-match": String(revision) },
    });

  it("edits one channel at its revision; other channels never conflict", async () => {
    const view = await routing();
    const alias = [{ name: "claude-opus-4-1", alias: "opus" }];

    const [a, b] = await Promise.all([
      put("aliases", "claude", view.revisions.aliases.claude ?? 0, alias),
      put("exclusions", "codex", view.revisions.exclusions.codex ?? 0, ["gpt-5-nano"]),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    const after = await routing();
    expect(after.aliases.claude).toEqual(alias);
    expect(after.excluded.codex).toEqual(["gpt-5-nano"]);
    expect(after.revisions.aliases.claude).toBe((a.body as { revision: number }).revision);

    const stale = await put("aliases", "claude", 0, [{ name: "claude-sonnet-4-5", alias: "x" }]);
    expect(stale.status).toBe(409);
    expect((await routing()).aliases.claude).toEqual(alias);
  });

  it("requires If-Match and answers 404 for a channel without rules", async () => {
    const missing = await json("/v9/management/model-rules/aliases/claude", jsonInit("PUT", []));
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: "invalid_if_match" });

    const removed = await json("/v9/management/model-rules/exclusions/claude", {
      method: "DELETE",
      headers: { "if-match": "0" },
    });

    expect(removed.status).toBe(404);
  });

  it("stores a provider's write-ins as normalised, shows them in the config and removes them", async () => {
    const view = await routing();

    const saved = await put("write-ins", " Claude ", view.revisions.write_ins.claude ?? 0, [
      { name: " claude-fable-5-2 ", like: "claude-fable-5-1", "display-name": "Fable 5.2" },
      { name: "CLAUDE-FABLE-5-2" },
      { name: "claude-mystery-1", like: "claude-mystery-1" },
    ]);

    expect(saved.status).toBe(200);
    const after = await routing();

    expect(after.write_ins.claude).toEqual([
      { name: "claude-fable-5-2", like: "claude-fable-5-1", "display-name": "Fable 5.2" },
      { name: "claude-mystery-1" },
    ]);
    expect(after.revisions.write_ins.claude).toBe((saved.body as { revision: number }).revision);

    expect((await current()).models["write-ins"]).toEqual({ claude: after.write_ins.claude });

    const empty = await put("write-ins", "claude", after.revisions.write_ins.claude ?? 0, [
      { name: "  " },
    ]);

    expect(empty.status).toBe(422);

    const removed = await json("/v9/management/model-rules/write-ins/claude", {
      method: "DELETE",
      headers: { "if-match": String(after.revisions.write_ins.claude ?? 0) },
    });

    expect(removed.status).toBe(200);
    expect((await routing()).write_ins).toEqual({});
  });
});
