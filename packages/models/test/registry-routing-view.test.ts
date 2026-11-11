// `routingView`: the admin view of the registry (which credentials serve each model, and why not), pure over a
// snapshot built from model sources.
import { describe, expect, it } from "vitest";
import { emptyQuota, emptyState } from "../src/credentials/model.ts";
import { routingView } from "../src/registry/routing-view.ts";
import { buildSnapshot } from "../src/registry/service.ts";
import type { ModelSource } from "../src/registry/source.ts";
import { authIndexOf } from "./support/auth-index.ts";
import { catalogs } from "./support/registry.ts";
import { configOf, source } from "./support/registry-sources.ts";

const NOW = 1_800_000_000_000;

const view = (sources: ModelSource[], yaml = "", now = NOW) =>
  routingView(
    buildSnapshot({ sources, config: configOf(yaml), catalogs, now, configVersion: 7 }),
    now,
    authIndexOf,
  );

/** Runtime state with overrides (the helper's default state minus the secret field). */
const stateWith = (overrides: Partial<ModelSource["state"]>): ModelSource["state"] => {
  const { rejectedAccessToken: _omitted, ...rest } = emptyState();

  return { ...rest, ...overrides };
};

type View = ReturnType<typeof view>;

const model = (result: View, id: string) => result.models.find((entry) => entry.id === id);

const ids = (result: View): string[] => result.models.map((entry) => entry.id);

const CHANNEL_ALIAS = `
oauth:
  model-alias:
    claude:
      - { name: claude-sonnet-4-6, alias: s46 }
`;

describe("routingView aliases", () => {
  it("an alias replaces the upstream id and says where the rule lives", () => {
    const result = view([source("a.json", "claude")], CHANNEL_ALIAS);

    expect(model(result, "claude-sonnet-4-6")).toBeUndefined();
    const aliased = model(result, "s46");

    expect(aliased?.listed).toBe(true);
    expect(aliased?.routes).toHaveLength(1);
    expect(aliased?.routes[0]).toMatchObject({
      via: "alias",
      upstream: "claude-sonnet-4-6",
      rule_scope: "channel",
      state: "available",
      channel: "claude",
      provider: "claude",
      source: "file",
      name: "a.json",
    });
    expect(model(result, "claude-haiku-4-5-20251001")?.routes[0]?.via).toBe("catalog");
  });

  it("fork keeps the original next to the alias", () => {
    const result = view(
      [source("a.json", "claude")],
      `
oauth:
  model-alias:
    claude:
      - { name: claude-sonnet-4-6, alias: s46, fork: true }
`,
    );

    expect(model(result, "claude-sonnet-4-6")?.routes[0]).toMatchObject({ via: "catalog" });
    expect(model(result, "s46")?.routes[0]).toMatchObject({
      via: "alias",
      upstream: "claude-sonnet-4-6",
    });
  });

  it("a per-account alias wins over the channel alias of the same name", () => {
    const result = view(
      [
        source("a.json", "claude", {
          modelAliases: [{ name: "claude-opus-4-6", alias: "s46" }],
        }),
      ],
      CHANNEL_ALIAS,
    );

    expect(model(result, "s46")?.routes[0]).toMatchObject({
      upstream: "claude-opus-4-6",
      rule_scope: "account",
    });
    // The channel entry lost its alias to the account's, so its model stays under the upstream id.
    expect(model(result, "claude-sonnet-4-6")?.routes[0]?.via).toBe("catalog");
  });

  it("echoes the channel rule maps, channels and config version", () => {
    const result = view(
      [source("a.json", "claude"), source("b.json", "claude"), source("c.json", "codex")],
      `${CHANNEL_ALIAS}
  excluded-models:
    codex: ["gpt-5*"]
`,
    );

    expect(result.config_version).toBe(7);
    expect(result.observed_at).toBe(new Date(NOW).toISOString());
    expect(result.force_model_prefix).toBe(false);
    expect(result.channels).toEqual([
      { channel: "claude", accounts: 2 },
      { channel: "codex", accounts: 1 },
    ]);
    expect(result.aliases).toEqual({ claude: [{ name: "claude-sonnet-4-6", alias: "s46" }] });
    expect(result.excluded).toEqual({ codex: ["gpt-5*"] });
    expect(result.write_ins).toEqual({});
  });
});

describe("routingView exclusions", () => {
  const EXCLUDED = `
oauth:
  model-alias:
    claude:
      - { name: claude-3-5-haiku-20241022, alias: haiku35 }
  excluded-models:
    claude: ["claude-3*"]
`;

  it("a channel pattern marks the upstream and its alias excluded", () => {
    const result = view([source("a.json", "claude", { excludedModels: ["claude-3*"] })], EXCLUDED);

    for (const id of ["claude-3-7-sonnet-20250219", "haiku35"]) {
      const entry = model(result, id);

      expect(entry?.listed, id).toBe(false);
      expect(entry?.providers, id).toEqual([]);
      expect(entry?.routes[0], id).toMatchObject({
        state: "excluded",
        reason: "claude-3*",
        rule_scope: "channel",
      });
    }

    expect(model(result, "haiku35")?.routes[0]?.upstream).toBe("claude-3-5-haiku-20241022");
    expect(model(result, "claude-sonnet-4-6")?.routes[0]?.state).toBe("available");
  });

  it("a pattern that is not in the channel list belongs to the account", () => {
    const result = view([source("a.json", "claude", { excludedModels: ["claude-opus-4-6"] })]);

    expect(model(result, "claude-opus-4-6")?.routes[0]).toMatchObject({
      state: "excluded",
      reason: "claude-opus-4-6",
      rule_scope: "account",
    });
  });

  it("a provider key's excluded-models are key rules and the key has no channel", () => {
    const result = view([
      source("claude:abc", "claude", {
        source: "config",
        authKind: "apikey",
        label: "claude-apikey",
        excludedModels: ["claude-opus-*"],
      }),
    ]);

    const opus = model(result, "claude-opus-4-6");

    expect(opus?.listed).toBe(false);
    expect(opus?.routes[0]).toMatchObject({
      state: "excluded",
      reason: "claude-opus-*",
      rule_scope: "key",
      source: "config",
      label: "claude-apikey",
    });
    expect(opus?.routes[0]?.channel).toBeUndefined();
    expect(opus?.routes[0]?.name).toBeUndefined();
    expect(result.channels).toEqual([]);
  });

  it("one credential excluding a model does not hide it from another", () => {
    const result = view([
      source("a.json", "claude", { excludedModels: ["claude-opus-4-6"] }),
      source("b.json", "claude"),
    ]);

    const opus = model(result, "claude-opus-4-6");

    expect(opus?.listed).toBe(true);
    expect(opus?.routes.map((route) => [route.name, route.state])).toEqual([
      ["a.json", "excluded"],
      ["b.json", "available"],
    ]);
  });
});

describe("routingView credential state", () => {
  it("a disabled credential's rows are disabled and its models are not listed", () => {
    const result = view([source("a.json", "claude", { disabled: true })]);

    expect(result.models.length).toBeGreaterThan(5);

    for (const entry of result.models) {
      expect(entry.listed).toBe(false);
      expect(entry.routes.map((route) => route.state)).toEqual(["disabled"]);
    }

    expect(result.channels).toEqual([{ channel: "claude", accounts: 1 }]);
  });

  it("a disabled credential does not remove the model another one serves", () => {
    const result = view([
      source("a.json", "claude", { disabled: true }),
      source("b.json", "claude"),
    ]);

    const entry = model(result, "claude-sonnet-4-6");

    expect(entry?.listed).toBe(true);
    expect(entry?.providers).toEqual(["claude"]);
    expect(entry?.routes.map((route) => route.state)).toEqual(["disabled", "available"]);
  });

  it("a model cooldown is cooling until the retry time; a lone cooling route is not listed", () => {
    const retry = NOW + 60_000;

    const cooling = source("a.json", "claude", {
      state: stateWith({
        status: "error",
        modelStates: {
          "claude-sonnet-4-6": {
            status: "error",
            unavailable: true,
            nextRetryAfter: retry,
            quota: emptyQuota(),
            lastError: { code: "overloaded", message: "busy", retryable: true },
            updatedAt: NOW,
          },
        },
      }),
    });

    const alone = model(view([cooling]), "claude-sonnet-4-6");

    expect(alone?.routes[0]).toMatchObject({
      state: "cooling",
      until: new Date(retry).toISOString(),
      reason: "overloaded",
    });
    expect(alone?.listed).toBe(false);
    // Other models of the credential are untouched.
    expect(model(view([cooling]), "claude-opus-4-6")?.routes[0]?.state).toBe("available");

    const withPeer = model(view([cooling, source("b.json", "claude")]), "claude-sonnet-4-6");

    expect(withPeer?.listed).toBe(true);
    expect(withPeer?.routes.map((route) => route.state)).toEqual(["cooling", "available"]);
  });

  it("an expired cooldown is available again", () => {
    const expired = source("a.json", "claude", {
      state: stateWith({
        modelStates: {
          "claude-sonnet-4-6": {
            status: "error",
            unavailable: false,
            nextRetryAfter: NOW - 1,
            quota: emptyQuota(),
            updatedAt: NOW - 60_000,
          },
        },
      }),
    });

    expect(model(view([expired]), "claude-sonnet-4-6")?.routes[0]?.state).toBe("available");
  });

  it("model quota is quota until it recovers and the model is still listed", () => {
    const recover = NOW + 120_000;

    const exceeded = source("a.json", "claude", {
      state: stateWith({
        modelStates: {
          "claude-sonnet-4-6": {
            status: "error",
            unavailable: true,
            nextRetryAfter: recover,
            quota: { exceeded: true, reason: "quota", nextRecoverAt: recover, backoffLevel: 1 },
            updatedAt: NOW,
          },
        },
      }),
    });

    const entry = model(view([exceeded]), "claude-sonnet-4-6");

    expect(entry?.listed).toBe(true);
    expect(entry?.routes[0]).toMatchObject({
      state: "quota",
      until: new Date(recover).toISOString(),
      reason: "quota",
    });
  });

  it("a credential-wide quota blocks all its models", () => {
    const recover = NOW + 300_000;

    const exceeded = source("a.json", "claude", {
      state: stateWith({
        quota: {
          exceeded: true,
          reason: "credential_quota",
          nextRecoverAt: recover,
          backoffLevel: 2,
        },
      }),
    });

    const result = view([exceeded]);

    for (const entry of result.models) {
      expect(entry.routes[0]).toMatchObject({
        state: "quota",
        until: new Date(recover).toISOString(),
      });
    }
  });
});

describe("routingView prefixes and configured models", () => {
  it("force-model-prefix leaves only prefixed ids, with the bare name as upstream", () => {
    const result = view(
      [source("a.json", "claude", { prefix: "p" })],
      "routing:\n  force-model-prefix: true\n",
    );

    expect(result.force_model_prefix).toBe(true);
    expect(ids(result).every((id) => id.startsWith("p/"))).toBe(true);
    expect(model(result, "p/claude-sonnet-4-6")?.routes[0]).toMatchObject({
      prefix: "p",
      upstream: "claude-sonnet-4-6",
      via: "catalog",
    });
  });

  it("without force, both the bare and the prefixed id are served", () => {
    const result = view([source("a.json", "claude", { prefix: "p" })]);

    expect(model(result, "claude-sonnet-4-6")?.routes[0]?.prefix).toBeUndefined();
    expect(model(result, "p/claude-sonnet-4-6")?.routes[0]?.prefix).toBe("p");
  });

  it("an OpenAI-compatible group is config-defined and has no channel", () => {
    const result = view([
      source("openai-compatibility:acme", "openai-compatibility", {
        source: "config",
        authKind: "apikey",
        label: "Acme",
        executor: "openai-compatible-acme",
        compat: true,
        excludedModels: ["*"],
        models: [{ name: "gpt-x", alias: "pool" }],
      }),
    ]);

    expect(ids(result)).toEqual(["pool"]);
    expect(model(result, "pool")).toMatchObject({
      listed: true,
      providers: ["openai-compatible-acme"],
      routes: [
        {
          via: "config",
          upstream: "gpt-x",
          label: "Acme",
          source: "config",
          provider: "openai-compatibility",
          state: "available",
        },
      ],
    });
    expect(model(result, "pool")?.routes[0]?.channel).toBeUndefined();
    expect(result.channels).toEqual([]);
  });

  it("a config key's models list replaces the catalog and is config-defined", () => {
    const result = view([
      source("claude:key", "claude", {
        source: "config",
        authKind: "apikey",
        models: [{ name: "claude-sonnet-4-6", alias: "mine" }],
      }),
    ]);

    expect(ids(result)).toEqual(["mine"]);
    expect(model(result, "mine")?.routes[0]).toMatchObject({
      via: "config",
      upstream: "claude-sonnet-4-6",
    });
  });
});

describe("routingView write-ins", () => {
  const WRITE_IN = `
models:
  write-ins:
    claude:
      - { name: claude-fable-5-2, like: claude-fable-5-1 }
`;

  it("a write-in is a route of every catalog credential of the provider, and the map is echoed", () => {
    const result = view(
      [
        source("a.json", "claude"),
        source("claude:key", "claude", { source: "config", authKind: "apikey" }),
      ],
      WRITE_IN,
    );

    const written = model(result, "claude-fable-5-2");

    expect(written?.listed).toBe(true);
    expect(written?.routes.map((route) => [route.source, route.via, route.upstream])).toEqual([
      ["file", "write-in", "claude-fable-5-2"],
      ["config", "write-in", "claude-fable-5-2"],
    ]);
    expect(model(result, "claude-fable-5-1")?.routes[0]?.via).toBe("catalog");
    expect(result.write_ins).toEqual({
      claude: [{ name: "claude-fable-5-2", like: "claude-fable-5-1" }],
    });
  });

  it("an alias of a write-in is an alias route", () => {
    const result = view(
      [source("a.json", "claude")],
      `${WRITE_IN}
oauth:
  model-alias:
    claude:
      - { name: claude-fable-5-2, alias: fable }
`,
    );

    expect(model(result, "claude-fable-5-2")).toBeUndefined();
    expect(model(result, "fable")?.routes[0]).toMatchObject({
      via: "alias",
      upstream: "claude-fable-5-2",
    });
  });
});

describe("routingView listing", () => {
  it("orders models by id and routes by credential id, with the registry's model record", () => {
    const result = view([source("b.json", "claude"), source("a.json", "claude")]);

    expect(ids(result)).toEqual(ids(result).toSorted());
    const entry = model(result, "claude-sonnet-4-6");

    expect(entry?.routes.map((route) => route.name)).toEqual(["a.json", "b.json"]);
    expect(entry).toMatchObject({ owned_by: "anthropic", type: "claude", listed: true });
    expect(entry?.routes[0]?.auth_index).toMatch(/^[0-9a-f]{16}$/);
    expect(entry?.routes[0]?.auth_index).not.toBe(entry?.routes[1]?.auth_index);
  });

  it("an unknown provider contributes nothing", () => {
    expect(view([source("a.json", "mystery")]).models).toEqual([]);
  });
});
