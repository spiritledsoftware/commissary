// Model routing per credential: prefixes (force-model-prefix), exclusions, OAuth aliases, provider-key model aliases,
// force-mapping and alias pools. Semantics from sdk/cliproxy/auth/{oauth_model_alias,conductor_models}.go and
// sdk/cliproxy/service_models.go.
import { describe, expect, it } from "vite-plus/test";
import {
  isModelExcluded,
  matchWildcard,
  parseModelSuffix,
  canonicalModelKey,
} from "../../src/credentials/selection/model-name.ts";
import {
  resolveModelRoute,
  rotateRoute,
  type RoutingContext,
} from "../../src/credentials/selection/routing.ts";
import { Harness, cred, defaultSettings, entry } from "../support/credentials.ts";

const context = (overrides: Partial<RoutingContext> = {}): RoutingContext => ({
  forceModelPrefix: false,
  oauthModelAlias: {},
  knownPrefixes: new Set(),
  ...overrides,
});

describe("model names", () => {
  it("parses thinking suffixes like Go", () => {
    expect(parseModelSuffix("gemini-2.5-pro(8192)")).toEqual({
      modelName: "gemini-2.5-pro",
      hasSuffix: true,
      rawSuffix: "8192",
    });
    expect(parseModelSuffix("plain")).toMatchObject({ modelName: "plain", hasSuffix: false });
    expect(parseModelSuffix("odd(")).toMatchObject({ hasSuffix: false });
    expect(canonicalModelKey(" m(high) ")).toBe("m");
    expect(canonicalModelKey("(x)")).toBe("(x)");
  });

  it("matches wildcards case-insensitively like matchWildcard", () => {
    for (const [pattern, value, expected] of [
      ["gpt-*", "gpt-5", true],
      ["*-preview", "gemini-3-preview", true],
      ["a*b", "axxb", true],
      ["a*b", "ab", true],
      ["a*b*c", "abc", true],
      ["a*b*c", "acb", false],
      ["exact", "exact", true],
      ["exact", "exactly", false],
      ["*", "anything", true],
      ["", "x", false],
      ["gpt-*", "o3", false],
    ] as const) {
      expect(matchWildcard(pattern, value), `${pattern} ~ ${value}`).toBe(expected);
    }

    expect(isModelExcluded(["gemini-*-preview"], "Gemini-3-Preview(8192)")).toBe(true);
    expect(isModelExcluded(["gemini-3"], "gemini-3-preview")).toBe(false);
  });
});

describe("prefixes", () => {
  const prefixed = cred("a", { prefix: "team" });

  it("serves prefixed and bare names, stripping the prefix for the upstream", () => {
    const ctx = context({ knownPrefixes: new Set(["team"]) });
    expect(resolveModelRoute(prefixed, "team/gpt-5", ctx)).toMatchObject({
      routeModel: "gpt-5",
      upstreamModel: "gpt-5",
    });
    expect(resolveModelRoute(prefixed, "gpt-5", ctx)).toMatchObject({ routeModel: "gpt-5" });
  });

  it("force-model-prefix hides the bare name (unless it equals the prefix)", () => {
    const ctx = context({ forceModelPrefix: true, knownPrefixes: new Set(["team"]) });
    expect(resolveModelRoute(prefixed, "gpt-5", ctx)).toBeUndefined();
    expect(resolveModelRoute(prefixed, "team/gpt-5", ctx)).toBeDefined();
    expect(resolveModelRoute(prefixed, "team", ctx)).toBeDefined();
    // unprefixed credentials are unaffected
    expect(resolveModelRoute(cred("b"), "gpt-5", ctx)).toBeDefined();
  });

  it("keeps `team/model` away from credentials of other namespaces", () => {
    const ctx = context({ knownPrefixes: new Set(["team"]) });
    expect(resolveModelRoute(cred("plain"), "team/gpt-5", ctx)).toBeUndefined();
    // ...unless they list that exact model
    const listed = cred("listed", { models: [{ name: "team/gpt-5" }] });
    expect(resolveModelRoute(listed, "team/gpt-5", ctx)?.upstreamModel).toBe("team/gpt-5");
    // a literal slash that is not a known prefix passes through
    expect(resolveModelRoute(cred("p"), "openai/gpt-4", ctx)?.upstreamModel).toBe("openai/gpt-4");
  });

  it("selection routes prefixed requests only to matching credentials", () => {
    const h = new Harness({ ...defaultSettings, forceModelPrefix: true });

    const pool = [
      entry(cred("a", { prefix: "team" })),
      entry(cred("b")),
      entry(cred("c", { prefix: "other" })),
    ];

    expect(h.ids(pool, 3, { model: "team/m" })).toEqual(["a", "a", "a"]);
    expect(h.id(pool, { model: "m" })).toBe("b");
    const route = h.select(pool, { model: "other/m(8192)" });
    expect(route.ok && route.route).toMatchObject({
      routeModel: "m(8192)",
      upstreamModel: "m(8192)",
    });
  });
});

describe("exclusions", () => {
  it("excludes upstream catalogue names by wildcard", () => {
    const excluded = cred("a", { excludedModels: ["gpt-*", "o1"] });
    expect(resolveModelRoute(excluded, "gpt-5", context())).toBeUndefined();
    expect(resolveModelRoute(excluded, "GPT-5(high)", context())).toBeUndefined();
    expect(resolveModelRoute(excluded, "o1", context())).toBeUndefined();
    expect(resolveModelRoute(excluded, "o3", context())).toBeDefined();
  });

  it("selection skips excluding credentials and fails when none serves the model", () => {
    const h = new Harness();
    const pool = [entry(cred("a", { excludedModels: ["m*"] })), entry(cred("b"))];
    expect(h.ids(pool, 3, { model: "model-x" })).toEqual(["b", "b", "b"]);
    expect(h.id([pool[0]!], { model: "model-x" })).toBe("failure:auth_not_found");
  });

  it("exclusion applies to the upstream name behind an alias", () => {
    const aliased = cred("a", {
      provider: "claude",
      excludedModels: ["gpt-5"],
      modelAliases: [{ name: "gpt-5", alias: "fast" }],
    });

    expect(resolveModelRoute(aliased, "fast", context())).toBeUndefined();
    expect(resolveModelRoute(aliased, "gpt-5", context())).toBeUndefined();
  });
});

describe("OAuth aliases", () => {
  const global = { claude: [{ name: "claude-sonnet-4-5", alias: "sonnet" }] };

  it("maps the alias to the upstream name and keeps the thinking suffix", () => {
    const credential = cred("a", { provider: "claude" });

    const route = resolveModelRoute(
      credential,
      "Sonnet(8192)",
      context({ oauthModelAlias: global }),
    );

    expect(route).toMatchObject({
      requestedModel: "Sonnet(8192)",
      upstreamModel: "claude-sonnet-4-5(8192)",
      originalAlias: "Sonnet(8192)",
      forceMapping: false,
      selectionModel: "claude-sonnet-4-5(8192)",
    });
  });

  it("the target's own suffix wins over the request's", () => {
    const credential = cred("a", { provider: "claude" });
    const ctx = context({ oauthModelAlias: { claude: [{ name: "m(1000)", alias: "fast" }] } });
    expect(resolveModelRoute(credential, "fast(8192)", ctx)?.upstreamModel).toBe("m(1000)");
  });

  it("per-account aliases take precedence over the global table; provider-key credentials have no alias channel", () => {
    const account = cred("a", {
      provider: "claude",
      modelAliases: [{ name: "mine", alias: "sonnet" }],
    });

    expect(
      resolveModelRoute(account, "sonnet", context({ oauthModelAlias: global }))?.upstreamModel,
    ).toBe("mine");
    const apikey = cred("k", { provider: "claude", authKind: "apikey" });
    expect(
      resolveModelRoute(apikey, "sonnet", context({ oauthModelAlias: global }))?.upstreamModel,
    ).toBe("sonnet");
    const gemini = cred("g", { provider: "gemini" });
    expect(
      resolveModelRoute(gemini, "sonnet", context({ oauthModelAlias: { gemini: global.claude } }))
        ?.upstreamModel,
    ).toBe("sonnet");
  });

  it("an alias equal to the upstream name is a no-op unless force-mapping", () => {
    const credential = cred("a", { provider: "claude" });
    const noop = context({ oauthModelAlias: { claude: [{ name: "same", alias: "SAME" }] } });
    expect(resolveModelRoute(credential, "same", noop)).toMatchObject({
      upstreamModel: "same",
      forceMapping: false,
    });

    const forced = context({
      oauthModelAlias: { claude: [{ name: "same", alias: "SAME", "force-mapping": true }] },
    });

    expect(resolveModelRoute(credential, "same", forced)).toMatchObject({
      forceMapping: true,
      originalAlias: "SAME",
    });
  });

  it("force-mapping reports the alias as the response model", () => {
    const credential = cred("a", { provider: "claude" });

    const ctx = context({
      oauthModelAlias: {
        claude: [{ name: "claude-sonnet-4-5", alias: "sonnet", "force-mapping": true }],
      },
    });

    expect(resolveModelRoute(credential, "sonnet(low)", ctx)).toMatchObject({
      upstreamModel: "claude-sonnet-4-5(low)",
      forceMapping: true,
      originalAlias: "sonnet",
    });
  });

  it("selection exposes the alias-resolved cooldown key", () => {
    const h = new Harness({ ...defaultSettings, oauthModelAlias: global });

    const outcome = h.select([entry(cred("a", { provider: "claude" }))], {
      providers: ["claude"],
      model: "sonnet(8192)",
    });

    expect(outcome.ok && outcome.route.selectionModel).toBe("claude-sonnet-4-5(8192)");
  });
});

describe("Provider-key model aliases and pools", () => {
  const compat = cred("k", {
    provider: "openai-compatible-x",
    authKind: "apikey",
    models: [
      { name: "gpt-4o", alias: "smart", "force-mapping": true },
      { name: "gpt-4o-mini", alias: "smart" },
      { name: "plain" },
    ],
  });

  it("configured models replace the catalogue: unknown models are unsupported", () => {
    expect(resolveModelRoute(compat, "other", context())).toBeUndefined();
    expect(resolveModelRoute(compat, "plain(8192)", context())).toMatchObject({
      upstreamModel: "plain(8192)",
    });
    expect(resolveModelRoute(compat, "gpt-4o", context())?.upstreamModel).toBe("gpt-4o");
  });

  it("aliases sharing a name form a pool that rotates between requests", () => {
    const route = resolveModelRoute(compat, "smart(high)", context())!;
    expect(route.upstreamModels).toEqual(["gpt-4o(high)", "gpt-4o-mini(high)"]);
    expect(route).toMatchObject({ forceMapping: true, originalAlias: "smart" });
    expect(rotateRoute(route, 1).upstreamModels).toEqual(["gpt-4o-mini(high)", "gpt-4o(high)"]);
    expect(rotateRoute(route, 1).upstreamModel).toBe("gpt-4o-mini(high)");
    expect(rotateRoute(route, 2)).toBe(route);
  });

  it("exclusions apply to configured models", () => {
    const excluding = cred("k", {
      authKind: "apikey",
      models: [{ name: "a" }, { name: "b-*" }],
      excludedModels: ["b-*"],
    });

    expect(resolveModelRoute(excluding, "a", context())).toBeDefined();
    expect(resolveModelRoute(excluding, "b-1", context())).toBeUndefined();
  });
});
