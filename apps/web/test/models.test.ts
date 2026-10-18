// The Models page's model (src/lib/models.ts): model standing and order, filters and search, origins, route
// standing and provenance, channel rules with live pattern matches, draft validation, and rule edits re-applied to
// the latest config after a 409.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { ManagementError } from "@commissary/contract/errors";
import type { ProviderKeysList } from "@commissary/contract/provider-keys";
import type { ModelRoute, RoutedModel, RoutingModels } from "@commissary/contract/routing";
import {
  aliasEntry,
  channelRules,
  exclusionMatches,
  isHidden,
  keyHomes,
  modelMatches,
  modelOrigins,
  modelProviders,
  modelStanding,
  needsAttention,
  patternMatches,
  planRuleChange,
  routeOrigin,
  routeProvenance,
  routeStanding,
  routeWho,
  type RuleWrite,
  saveRuleChange,
  sortModels,
  stateCounts,
  upstreamNote,
  validateAlias,
  validateChannel,
  validatePattern,
} from "../src/lib/models.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");

const route = (overrides: Partial<ModelRoute> = {}): ModelRoute => ({
  auth_index: "a1",
  source: "file",
  provider: "claude",
  channel: "claude",
  label: "ian@example.com",
  name: "claude-ian.json",
  upstream: "claude-opus-4-5",
  via: "catalog",
  state: "available",
  ...overrides,
});

const model = (
  id: string,
  routes: ReadonlyArray<ModelRoute>,
  overrides: Partial<RoutedModel> = {},
): RoutedModel => ({
  id,
  owned_by: "anthropic",
  type: "claude",
  listed: routes.some((entry) => entry.state === "available" || entry.state === "quota"),
  providers: routes.some((entry) => entry.state === "available") ? ["claude"] : [],
  routes,
  ...overrides,
});

const view = (overrides: Partial<RoutingModels> = {}): RoutingModels => ({
  observed_at: new Date(NOW).toISOString(),
  config_version: 5,
  revisions: { aliases: { claude: 5 }, exclusions: { claude: 2 } },
  force_model_prefix: false,
  channels: [{ channel: "claude", accounts: 2 }],
  aliases: {},
  excluded: {},
  models: [],
  ...overrides,
});

describe("model standing", () => {
  it("counts routes by state", () => {
    const counts = stateCounts(
      model("m", [route(), route({ state: "cooling" }), route({ state: "excluded" })]),
    );

    expect(counts).toMatchObject({ available: 1, cooling: 1, excluded: 1, quota: 0 });
  });

  it("says how many of the routes that could serve take requests", () => {
    expect(modelStanding(model("m", [route()]))).toEqual({
      tone: "ok",
      label: "Taking requests",
      details: [],
    });
    expect(modelStanding(model("m", [route(), route()])).label).toBe(
      "All 2 routes taking requests",
    );
    expect(
      modelStanding(
        model("m", [
          route(),
          route({ state: "available" }),
          route({ state: "cooling" }),
          route({ state: "excluded" }),
        ]),
      ),
    ).toEqual({
      tone: "partial",
      label: "2 of 4 routes taking requests",
      details: ["1 resting", "1 excluded"],
    });
    // Every route that could serve does, but one is switched off: still counted.
    expect(modelStanding(model("m", [route(), route({ state: "disabled" })]))).toEqual({
      tone: "ok",
      label: "1 of 2 routes taking requests",
      details: ["1 disabled"],
    });
  });

  it("is closed when no route that could serve takes requests", () => {
    const standing = modelStanding(
      model("m", [route({ state: "quota" }), route({ state: "cooling" })]),
    );

    expect(standing.tone).toBe("closed");
    expect(standing.label).toBe("No route taking requests");
    expect(standing.details).toEqual(["1 resting", "1 out of quota"]);
    expect(modelStanding(model("m", [route({ state: "quota" })])).label).toBe(
      "Not taking requests",
    );
  });

  it("is inert when rules or disabled accounts take every route away", () => {
    expect(modelStanding(model("m", [route({ state: "excluded" })])).label).toBe("Excluded");
    expect(
      modelStanding(model("m", [route({ state: "disabled" }), route({ state: "disabled" })])).label,
    ).toBe("Disabled on every route");
    expect(
      modelStanding(model("m", [route({ state: "disabled" }), route({ state: "excluded" })])),
    ).toEqual({ tone: "inert", label: "Excluded or disabled on every route", details: [] });
  });

  it("needs attention only for routes that could serve and do not", () => {
    expect(needsAttention(model("m", [route(), route({ state: "quota" })]))).toBe(true);
    expect(needsAttention(model("m", [route(), route({ state: "excluded" })]))).toBe(false);
    expect(needsAttention(model("m", [route({ state: "disabled" })]))).toBe(false);
  });

  it("is hidden when /v1/models does not list it", () => {
    expect(isHidden(model("m", [route({ state: "excluded" })]))).toBe(true);
    expect(isHidden(model("m", [route()]))).toBe(false);
  });

  it("orders problems first, then healthy, then taken away, by id within each", () => {
    const sorted = sortModels([
      model("b-ok", [route()]),
      model("gone", [route({ state: "excluded" })]),
      model("a-ok", [route()]),
      model("partial", [route(), route({ state: "cooling" })]),
      model("closed", [route({ state: "cooling" })]),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(["closed", "partial", "a-ok", "b-ok", "gone"]);
  });
});

describe("search, providers, origins", () => {
  const opus = model(
    "opus",
    [
      route({ via: "alias", upstream: "claude-opus-4-5" }),
      route({
        source: "config",
        provider: "claude",
        label: "claude-apikey",
        via: "config",
        prefix: "team",
      }),
    ],
    { display_name: "Claude Opus 4.5" },
  );

  it("matches the id, display name, upstream names, labels and provider names", () => {
    for (const query of ["opus", "claude opus", "opus-4-5", "ian@", "apikey", "claude", ""]) {
      expect(modelMatches(opus, query)).toBe(true);
    }

    expect(modelMatches(opus, "gemini")).toBe(false);
  });

  it("names providers, falling back to the routes' when nobody serves it", () => {
    expect(modelProviders(model("m", [route()], { providers: ["claude", "antigravity"] }))).toEqual(
      ["Claude", "Antigravity"],
    );
    expect(modelProviders(model("m", [route({ state: "excluded", provider: "codex" })]))).toEqual([
      "Codex",
    ]);
  });

  it("says where the id comes from", () => {
    expect(modelOrigins(opus)).toEqual(["Alias of claude-opus-4-5", "Key config", "Prefix team/"]);
    expect(modelOrigins(model("m", [route()]))).toEqual(["Catalog"]);
  });

  it("says each route's origin in the same words, and the provider's name where the id differs", () => {
    const [alias, key] = opus.routes;

    expect(alias === undefined ? undefined : routeOrigin(alias)).toBe("Alias of claude-opus-4-5");
    expect(key === undefined ? undefined : routeOrigin(key)).toBe("Key config");
    expect(routeOrigin(route())).toBe("Catalog");
    expect(upstreamNote("team/claude-opus-4-5", route())).toBe("as claude-opus-4-5");
    expect(upstreamNote("claude-opus-4-5", route())).toBeUndefined();
    expect(upstreamNote("opus", route({ via: "alias" }))).toBeUndefined();
  });
});

describe("routes", () => {
  it("reads each state, with the time a resting route is back while it is ahead", () => {
    const until = new Date(NOW + 47 * 60_000).toISOString();

    expect(routeStanding(route(), NOW)).toEqual({
      tone: "ok",
      label: "Taking requests",
      backAt: undefined,
    });
    expect(routeStanding(route({ state: "cooling", reason: "quota", until }), NOW)).toEqual({
      tone: "closed",
      label: "Resting: Rate limit",
      backAt: NOW + 47 * 60_000,
    });
    expect(
      routeStanding(route({ state: "cooling", until: new Date(NOW - 1).toISOString() }), NOW)
        .backAt,
    ).toBeUndefined();
    expect(routeStanding(route({ state: "quota", reason: "credential_quota" }), NOW).label).toBe(
      "Account quota used up",
    );
    expect(
      routeStanding(route({ state: "unavailable", reason: "model_not_found" }), NOW).label,
    ).toBe("Unavailable: model_not_found");
    expect(routeStanding(route({ state: "disabled", source: "config" }), NOW)).toEqual({
      tone: "off",
      label: "Key disabled",
      backAt: undefined,
    });
  });

  it("names the rule behind an exclusion or an alias", () => {
    expect(
      routeProvenance(route({ state: "excluded", reason: "claude-3*", rule_scope: "channel" })),
    ).toEqual({ kind: "excluded", scope: "channel", pattern: "claude-3*", channel: "claude" });
    expect(routeProvenance(route({ via: "alias", rule_scope: "account" }))).toEqual({
      kind: "alias",
      scope: "account",
      pattern: undefined,
      channel: "claude",
    });
    expect(routeProvenance(route())).toBeUndefined();
  });
});

describe("channel rules", () => {
  // A provider key route: no channel.
  const { channel: _channel, ...keyRoute } = route({ source: "config", upstream: "k1" });

  const routed = view({
    channels: [
      { channel: "claude", accounts: 2 },
      { channel: "codex", accounts: 1 },
    ],
    aliases: { claude: [{ name: "claude-opus-4-5", alias: "opus" }], "kimi.com": [] },
    excluded: { gemini: ["gemini-1*"] },
    models: [
      model("claude-opus-4-5", [route(), route({ auth_index: "a2" })]),
      model("claude-3-7-sonnet", [route({ upstream: "claude-3-7-sonnet", state: "excluded" })]),
      model("gpt-5", [route({ channel: "codex", provider: "codex", upstream: "gpt-5" })]),
      model("k1", [keyRoute]),
    ],
  });

  it("lists channels with accounts or rules, flags the ones no account uses", () => {
    const rules = channelRules(routed, ["xai"]);

    expect(rules.map((entry) => [entry.channel, entry.accounts, entry.inert])).toEqual([
      ["claude", 2, false],
      ["codex", 1, false],
      ["gemini", 0, true],
      ["kimi.com", 0, true],
      ["xai", 0, true],
    ]);
    expect(rules[0]?.upstreams).toEqual(["claude-3-7-sonnet", "claude-opus-4-5"]);
    expect(rules[0]?.aliases).toEqual([{ name: "claude-opus-4-5", alias: "opus" }]);
    expect(rules[2]?.excluded).toEqual(["gemini-1*"]);
  });

  it("matches patterns like the server: * wildcards, case-insensitive, otherwise literal", () => {
    expect(patternMatches("claude-3*", "Claude-3-7-Sonnet")).toBe(true);
    expect(patternMatches("*-sonnet", "claude-3-7-sonnet")).toBe(true);
    expect(patternMatches("claude*sonnet", "claude-3-7-sonnet")).toBe(true);
    expect(patternMatches("claude-3", "claude-3-7-sonnet")).toBe(false);
    expect(patternMatches("gpt-5.1", "gpt-5x1")).toBe(false);
    expect(patternMatches("a*a", "a")).toBe(false);
    expect(patternMatches(" ", "a")).toBe(false);
    expect(exclusionMatches("claude-*", ["claude-opus-4-5", "claude-3-7-sonnet", "gpt-5"])).toEqual(
      ["claude-opus-4-5", "claude-3-7-sonnet"],
    );
  });
});

describe("drafts", () => {
  const aliases = [{ name: "claude-opus-4-5", alias: "opus" }];

  it("validates a channel key", () => {
    expect(validateChannel("")).toMatch(/Enter a channel/);
    expect(validateChannel("Claude")).toMatch(/lower-case/);
    expect(validateChannel("kimi_com")).toMatch(/lower-case/);
    expect(validateChannel("kimi.com")).toBeUndefined();
    expect(validateChannel("claude", ["claude"])).toMatch(/already/);
  });

  it("validates an alias: both names, a real rename, no duplicate alias", () => {
    expect(validateAlias({ name: " ", alias: "", fork: false }, aliases)).toEqual({
      name: "Enter the provider's model name.",
      alias: "Enter the name clients will call.",
    });
    expect(validateAlias({ name: "gpt-5", alias: "GPT-5", fork: false }, aliases).alias).toMatch(
      /provider's name already/,
    );
    expect(
      validateAlias({ name: "claude-sonnet-4-5", alias: "Opus", fork: false }, aliases).alias,
    ).toBe("opus is already the alias of claude-opus-4-5 on this channel.");
    // The entry being edited may keep its own alias.
    expect(
      validateAlias({ name: "claude-opus-4-1", alias: "opus", fork: true }, aliases, aliases[0]),
    ).toEqual({});
  });

  it("keeps the settings the form does not show when editing", () => {
    const stored = { name: "a", alias: "b", fork: true, "display-name": "B" };

    expect(aliasEntry({ name: " a ", alias: "c ", fork: false }, stored)).toEqual({
      name: "a",
      alias: "c",
      "display-name": "B",
    });
    expect(aliasEntry({ name: "a", alias: "b", fork: true })).toEqual({
      name: "a",
      alias: "b",
      fork: true,
    });
  });

  it("validates an exclusion pattern", () => {
    expect(validatePattern(" ", [])).toMatch(/Enter a model name/);
    expect(validatePattern("claude 3", [])).toMatch(/no spaces/);
    expect(validatePattern("Claude-3*", ["claude-3*"])).toMatch(/already excluded/);
    expect(validatePattern("claude-3*", [])).toBeUndefined();
  });
});

describe("planRuleChange", () => {
  const opus = { name: "claude-opus-4-5", alias: "opus" };
  const sonnet = { name: "claude-sonnet-4-5", alias: "sonnet", fork: true };
  const base = view({ aliases: { claude: [opus] }, excluded: { claude: ["claude-3*"] } });

  it("adds, removes and replaces an alias in the channel's whole list", () => {
    expect(
      planRuleChange(base, { rule: "aliases", channel: "claude", op: "add", entry: sonnet }),
    ).toEqual({
      kind: "write",
      write: { kind: "put-aliases", channel: "claude", body: [opus, sonnet] },
    });
    expect(
      planRuleChange(base, {
        rule: "aliases",
        channel: "claude",
        op: "replace",
        from: opus,
        to: { ...opus, alias: "big" },
      }),
    ).toEqual({
      kind: "write",
      write: { kind: "put-aliases", channel: "claude", body: [{ ...opus, alias: "big" }] },
    });
    expect(
      planRuleChange(base, { rule: "aliases", channel: "claude", op: "remove", entry: opus }),
    ).toEqual({
      kind: "write",
      write: { kind: "delete-aliases", channel: "claude" },
    });
  });

  it("adds and removes exclusion patterns, lower-cased", () => {
    expect(
      planRuleChange(base, {
        rule: "excluded",
        channel: "claude",
        op: "add",
        pattern: "Claude-2*",
      }),
    ).toEqual({
      kind: "write",
      write: { kind: "put-excluded", channel: "claude", body: ["claude-3*", "claude-2*"] },
    });
    expect(
      planRuleChange(base, {
        rule: "excluded",
        channel: "claude",
        op: "remove",
        pattern: "claude-3*",
      }),
    ).toEqual({ kind: "write", write: { kind: "delete-excluded", channel: "claude" } });
    expect(
      planRuleChange(base, { rule: "excluded", channel: "codex", op: "add", pattern: "gpt-4*" }),
    ).toEqual({
      kind: "write",
      write: { kind: "put-excluded", channel: "codex", body: ["gpt-4*"] },
    });
  });

  it("re-applies to a newer list: done already is nothing to do, the same entry changed is a conflict", () => {
    // Someone else added the same alias: nothing to do.
    expect(
      planRuleChange(view({ aliases: { claude: [opus] } }), {
        rule: "aliases",
        channel: "claude",
        op: "add",
        entry: opus,
      }),
    ).toEqual({ kind: "none" });
    // The alias now names another model.
    expect(
      planRuleChange(view({ aliases: { claude: [{ ...opus, name: "claude-opus-4-1" }] } }), {
        rule: "aliases",
        channel: "claude",
        op: "add",
        entry: opus,
      }),
    ).toEqual({ kind: "conflict" });
    // Removed already.
    expect(
      planRuleChange(view(), { rule: "aliases", channel: "claude", op: "remove", entry: opus }),
    ).toEqual({ kind: "none" });
    // Edited meanwhile.
    expect(
      planRuleChange(view({ aliases: { claude: [{ ...opus, fork: true }] } }), {
        rule: "aliases",
        channel: "claude",
        op: "remove",
        entry: opus,
      }),
    ).toEqual({ kind: "conflict" });
    expect(
      planRuleChange(view({ aliases: { claude: [{ ...opus, fork: true }] } }), {
        rule: "aliases",
        channel: "claude",
        op: "replace",
        from: opus,
        to: { ...opus, alias: "big" },
      }),
    ).toEqual({ kind: "conflict" });
    // The new alias was taken meanwhile by another entry.
    expect(
      planRuleChange(view({ aliases: { claude: [opus, { name: "x", alias: "big" }] } }), {
        rule: "aliases",
        channel: "claude",
        op: "replace",
        from: opus,
        to: { ...opus, alias: "big" },
      }),
    ).toEqual({ kind: "conflict" });
    // Another edit elsewhere in the list is kept.
    expect(
      planRuleChange(view({ aliases: { claude: [opus, sonnet] } }), {
        rule: "aliases",
        channel: "claude",
        op: "remove",
        entry: opus,
      }),
    ).toEqual({ kind: "write", write: { kind: "put-aliases", channel: "claude", body: [sonnet] } });
    expect(
      planRuleChange(view(), { rule: "excluded", channel: "claude", op: "remove", pattern: "x" }),
    ).toEqual({ kind: "none" });
  });
});

describe("saveRuleChange", () => {
  const opus = { name: "claude-opus-4-5", alias: "opus" };
  const sonnet = { name: "claude-sonnet-4-5", alias: "sonnet" };
  const change = { rule: "aliases", channel: "claude", op: "add", entry: sonnet } as const;

  /** The revision of the entry a write touches in `latest` (what the server compares `If-Match` with). */
  const current = (latest: RoutingModels, write: RuleWrite): number => {
    const aliases = write.kind === "put-aliases" || write.kind === "delete-aliases";

    return (aliases ? latest.revisions.aliases : latest.revisions.exclusions)[write.channel] ?? 0;
  };

  /** A fake server: refuses writes whose revision is not the entry's in `latest`, answers reads with `latest`. */
  const server = (latest: RoutingModels, refuseAll = false) => {
    const writes: Array<readonly [RuleWrite, number]> = [];

    return {
      writes,
      io: {
        read: Effect.succeed(latest),
        write: (write: RuleWrite, revision: number) => {
          writes.push([write, revision]);

          return refuseAll || revision !== current(latest, write)
            ? Effect.fail(new ManagementError({ error: "conflict" }))
            : Effect.succeed({ status: "ok" as const, version: 100, revision: revision + 1 });
        },
      },
    };
  };

  it.effect("saves against the page's view with the channel's alias revision", () =>
    Effect.gen(function* () {
      const base = view({ aliases: { claude: [opus] } });
      const fake = server(base);

      expect(yield* saveRuleChange(change, base, fake.io)).toBe("saved");
      expect(fake.writes).toEqual([
        [{ kind: "put-aliases", channel: "claude", body: [opus, sonnet] }, 5],
      ]);
    }),
  );

  it.effect(
    "sends the exclusion revision for an exclusion edit, and 0 for a channel without rules",
    () =>
      Effect.gen(function* () {
        const base = view({ excluded: { claude: ["claude-3*"] } });
        const fake = server(base);

        yield* saveRuleChange(
          { rule: "excluded", channel: "claude", op: "add", pattern: "claude-2*" },
          base,
          fake.io,
        );

        yield* saveRuleChange(
          { rule: "excluded", channel: "codex", op: "add", pattern: "gpt-3*" },
          base,
          fake.io,
        );

        yield* saveRuleChange(
          { rule: "aliases", channel: "codex", op: "add", entry: opus },
          base,
          fake.io,
        );

        expect(fake.writes).toEqual([
          [{ kind: "put-excluded", channel: "claude", body: ["claude-3*", "claude-2*"] }, 2],
          [{ kind: "put-excluded", channel: "codex", body: ["gpt-3*"] }, 0],
          [{ kind: "put-aliases", channel: "codex", body: [opus] }, 0],
        ]);
      }),
  );

  it.effect(
    "re-reads after a 409 and applies the same change to the latest list and revision",
    () =>
      Effect.gen(function* () {
        const base = view({ aliases: { claude: [opus] } });
        const other = { name: "claude-haiku-4-5", alias: "haiku" };

        const fake = server(
          view({
            revisions: { aliases: { claude: 9 }, exclusions: {} },
            aliases: { claude: [opus, other] },
          }),
        );

        expect(yield* saveRuleChange(change, base, fake.io)).toBe("saved");
        expect(fake.writes.map(([write, revision]) => [write, revision])).toEqual([
          [{ kind: "put-aliases", channel: "claude", body: [opus, sonnet] }, 5],
          [{ kind: "put-aliases", channel: "claude", body: [opus, other, sonnet] }, 9],
        ]);
      }),
  );

  it.effect(
    "fails with conflict when the same entry changed meanwhile, without writing again",
    () =>
      Effect.gen(function* () {
        const base = view({ aliases: { claude: [opus] } });

        const fake = server(
          view({
            revisions: { aliases: { claude: 9 }, exclusions: {} },
            aliases: { claude: [{ ...sonnet, fork: true }] },
          }),
        );

        const exit = yield* Effect.exit(saveRuleChange(change, base, fake.io));

        expect(exit).toStrictEqual(Exit.fail(new ManagementError({ error: "conflict" })));
        expect(fake.writes).toHaveLength(1);
      }),
  );

  it.effect("retries only once", () =>
    Effect.gen(function* () {
      const base = view({ aliases: { claude: [opus] } });

      const fake = server(
        view({
          revisions: { aliases: { claude: 9 }, exclusions: {} },
          aliases: { claude: [opus] },
        }),
        true,
      );

      const exit = yield* Effect.exit(saveRuleChange(change, base, fake.io));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(fake.writes).toHaveLength(2);
    }),
  );

  it.effect("treats a list another edit already deleted as deleted", () =>
    Effect.gen(function* () {
      const base = view({ excluded: { claude: ["claude-3*"] } });

      const io = {
        read: Effect.succeed(base),
        write: () => Effect.fail(new ManagementError({ error: "not_found" })),
      };

      expect(
        yield* saveRuleChange(
          { rule: "excluded", channel: "claude", op: "remove", pattern: "claude-3*" },
          base,
          io,
        ),
      ).toBe("saved");
    }),
  );

  it.effect("does nothing when the list already holds the change", () =>
    Effect.gen(function* () {
      const base = view({ aliases: { claude: [opus, sonnet] } });
      const fake = server(base);

      expect(yield* saveRuleChange(change, base, fake.io)).toBe("unchanged");
      expect(fake.writes).toEqual([]);
    }),
  );
});

describe("who serves a route", () => {
  const keys: ProviderKeysList = {
    version: 3,
    families: {
      gemini: [],
      interactions: [],
      vertex: [],
      codex: [],
      claude: [
        {
          id: "grp-team",
          revision: 4,
          index: 1,
          group: {
            name: "team",
            keys: [
              { auth_index: "k1", key_preview: "[redacted]…abcd", disabled: false, runtime: null },
              { key_preview: "[redacted]…none", disabled: false, runtime: null },
            ],
          },
          effective_base_url: "https://api.anthropic.com",
          warnings: [],
        },
      ],
      xai: [],
      meta: [],
      "opencode-zen": [],
      "opencode-go": [],
      typesafe: [],
      subq: [],
      "openai-compatibility": [
        {
          id: "grp-openrouter",
          revision: 1,
          index: 0,
          group: {
            name: "openrouter",
            "base-url": "https://openrouter.ai/api/v1",
            keys: [
              { auth_index: "c1", key_preview: "[redacted]…wxyz", disabled: false, runtime: null },
            ],
          },
          effective_base_url: "https://openrouter.ai/api/v1",
          warnings: [],
        },
      ],
    },
  };

  const homes = keyHomes(keys);

  it("finds every configured key with an auth index, in its group", () => {
    expect([...homes.keys()]).toEqual(["k1", "c1"]);
    expect(homes.get("k1")).toMatchObject({ family: "claude", index: 1, group: "team" });
    expect(homes.get("c1")).toMatchObject({
      family: "openai-compatibility",
      index: 0,
      name: "openrouter",
      group: "OpenAI-compatible",
    });
  });

  it("names an account by its label and links to it", () => {
    expect(routeWho(route(), homes)).toEqual({
      name: "ian@example.com",
      detail: "Claude",
      home: { kind: "account", authIndex: "a1" },
    });
  });

  it("names a known key by its group and links to the group", () => {
    const who = routeWho(route({ source: "config", auth_index: "k1", label: "" }), homes);

    expect(who.home).toEqual({ kind: "key", family: "claude", index: 1 });
    expect(who.detail).toBe("team");
  });

  it("falls back to the provider keys page for a key the list does not know", () => {
    expect(
      routeWho(route({ source: "config", auth_index: "zz", provider: "claude" }), homes),
    ).toEqual({ name: "Claude provider key", detail: undefined, home: { kind: "keys" } });
    expect(
      routeWho(
        route({
          source: "config",
          auth_index: "zz",
          provider: "openai-compatible-groq",
          label: "groq",
        }),
        homes,
      ),
    ).toEqual({ name: "groq", detail: "OpenAI-compatible", home: { kind: "keys" } });
  });
});
