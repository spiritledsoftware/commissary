// Per-credential model assembly (port of sdk/cliproxy/service_models.go); cases mirror the Go unit tests
// service_oauth_model_alias_test.go, service_oauth_settings_test.go and the registration rules in
// docs/research/config-management-oauth.md §4.2.
import { describe, expect, it } from "vitest";
import {
  applyExcludedModels,
  applyModelPrefixes,
  applyOAuthModelAliasEntries,
  assembleCredentialModels,
  oauthModelAliasChannel,
} from "../src/registry/credential-models.ts";
import { embeddedCatalogs, sectionModels } from "../src/registry/catalog.ts";
import type { ModelInfo } from "../src/registry/model-info.ts";
import { ids, options, source } from "./support/registry-sources.ts";

const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  object: "model",
  created: 1,
  ownedBy: "x",
  type: "x",
  ...extra,
});

const catalogs = embeddedCatalogs();

describe("applyOAuthModelAliasEntries", () => {
  it("renames and rewrites the Gemini-style name and display name", () => {
    const out = applyOAuthModelAliasEntries(
      [{ name: "gpt-5", alias: "g5", "display-name": "Configured GPT Five" }],
      [model("gpt-5", { name: "models/gpt-5", displayName: "Upstream GPT Five" })],
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "g5",
      name: "models/g5",
      displayName: "Configured GPT Five",
      metadataModelId: "gpt-5",
    });
  });

  it("keeps the upstream display name by default", () => {
    const out = applyOAuthModelAliasEntries(
      [{ name: "gpt-5", alias: "g5" }],
      [model("gpt-5", { displayName: "Upstream" })],
    );

    expect(out[0]?.displayName).toBe("Upstream");
  });

  it("fork keeps the original and adds one entry per alias", () => {
    const out = applyOAuthModelAliasEntries(
      [
        { name: "gpt-5", alias: "g5", fork: true, "display-name": "Configured" },
        { name: "gpt-5", alias: "g5-2", fork: true },
      ],
      [model("gpt-5", { name: "models/gpt-5", displayName: "Upstream" })],
    );

    expect(ids(out)).toEqual(["gpt-5", "g5", "g5-2"]);
    expect(out.map((entry) => entry.name)).toEqual(["models/gpt-5", "models/g5", "models/g5-2"]);
    expect(out[0]?.displayName).toBe("Upstream");
    expect(out[1]?.displayName).toBe("Configured");
  });

  it("ignores aliases equal to the name and keeps metadata ids", () => {
    const out = applyOAuthModelAliasEntries(
      [
        { name: "gpt-6-astra", alias: "codex-main", fork: true },
        { name: "gpt-5.6-luna", alias: "codex-luna" },
        { name: "same", alias: "SAME" },
      ],
      [model("gpt-6-astra"), model("gpt-5.6-luna"), model("same")],
    );

    expect(ids(out)).toEqual(["gpt-6-astra", "codex-main", "codex-luna", "same"]);
    expect(out.find((entry) => entry.id === "codex-main")?.metadataModelId).toBe("gpt-6-astra");
    expect(out.find((entry) => entry.id === "codex-luna")?.metadataModelId).toBe("gpt-5.6-luna");
  });
});

describe("applyModelPrefixes", () => {
  const webSearch = { webSearch: true };

  const models = [
    model("gpt-6-astra"),
    model("codex-main", { metadataModelId: "gpt-6-astra", nativeCapabilities: webSearch }),
  ];

  it("adds prefixed clones, keeps metadata ids and does not alias the source", () => {
    const out = applyModelPrefixes(models, "1", false);
    expect(ids(out)).toEqual(["gpt-6-astra", "1/gpt-6-astra", "codex-main", "1/codex-main"]);
    expect(out.find((entry) => entry.id === "1/gpt-6-astra")?.metadataModelId).toBe("gpt-6-astra");
    const prefixed = out.find((entry) => entry.id === "1/codex-main");
    expect(prefixed?.metadataModelId).toBe("gpt-6-astra");
    expect(prefixed?.nativeCapabilities).toEqual(webSearch);
    expect(prefixed?.nativeCapabilities).not.toBe(models[1]?.nativeCapabilities);
  });

  it("force-model-prefix hides the plain ids (unless prefix equals the id)", () => {
    expect(ids(applyModelPrefixes(models, "team", true))).toEqual([
      "team/gpt-6-astra",
      "team/codex-main",
    ]);
    expect(ids(applyModelPrefixes([model("team")], "team", true))).toEqual(["team", "team/team"]);
    expect(ids(applyModelPrefixes(models, undefined, true))).toEqual(["gpt-6-astra", "codex-main"]);
  });
});

describe("applyExcludedModels", () => {
  const list = ["gpt-5", "gpt-5-mini", "o3", "Claude-Haiku-4"].map((id) => model(id));
  it("matches patterns case-insensitively with * wildcards", () => {
    expect(ids(applyExcludedModels(list, ["GPT-*"]))).toEqual(["o3", "Claude-Haiku-4"]);
    expect(ids(applyExcludedModels(list, ["*mini", "o3"]))).toEqual(["gpt-5", "Claude-Haiku-4"]);
    expect(ids(applyExcludedModels(list, ["*haiku*"]))).toEqual(["gpt-5", "gpt-5-mini", "o3"]);
    expect(ids(applyExcludedModels(list, ["  ", ""]))).toEqual(ids(list));
  });
});

describe("oauthModelAliasChannel", () => {
  it("is empty for provider keys and gemini", () => {
    expect(oauthModelAliasChannel("claude", "oauth")).toBe("claude");
    expect(oauthModelAliasChannel("claude", "apikey")).toBe("");
    expect(oauthModelAliasChannel("claude", "api-key")).toBe("");
    expect(oauthModelAliasChannel("gemini", "oauth")).toBe("");
    expect(oauthModelAliasChannel("Kimi.com", undefined)).toBe("kimi.com");
  });
});

describe("assembleCredentialModels: catalog providers", () => {
  it("registers under the executor key (kimi.com -> kimi)", () => {
    const assembled = assembleCredentialModels(
      source("k", "kimi.com", { executor: "kimi" }),
      options(),
    );

    expect(assembled?.provider).toBe("kimi");
    expect(ids(assembled?.models)).toEqual(ids(sectionModels(catalogs, "kimi")));
  });

  it.each([
    ["pro", "codex-pro"],
    ["PLUS", "codex-plus"],
    ["team", "codex-team"],
    ["business", "codex-team"],
    ["go", "codex-team"],
    ["free", "codex-free"],
    ["enterprise", "codex-pro"],
    [undefined, "codex-pro"],
  ] as const)("codex plan %s uses %s", (planType, section) => {
    const assembled = assembleCredentialModels(
      source("c", "codex", planType === undefined ? {} : { planType }),
      options(),
    );

    expect(ids(assembled?.models)).toEqual(ids(sectionModels(catalogs, section)));
  });

  it("applies per-credential exclusions before aliases and the prefix", () => {
    const assembled = assembleCredentialModels(
      source("c", "codex", {
        planType: "free",
        prefix: "acme",
        excludedModels: ["gpt-6-*", "codex-auto-*"],
        modelAliases: [{ name: "gpt-5.5", alias: "main", fork: true }],
      }),
      options("routing:\n  force-model-prefix: false\n"),
    );

    expect(ids(assembled?.models)).toEqual([
      "gpt-5.5",
      "acme/gpt-5.5",
      "main",
      "acme/main",
      "gpt-5.6-terra",
      "acme/gpt-5.6-terra",
      "gpt-5.6-luna",
      "acme/gpt-5.6-luna",
      "gpt-image-1.5",
      "acme/gpt-image-1.5",
      "gpt-image-2",
      "acme/gpt-image-2",
      "gpt-image-2.5-flare",
      "acme/gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
      "acme/gpt-image-2.5-sunburst",
      "gpt-image-2.5",
      "acme/gpt-image-2.5",
    ]);
    expect(assembled?.models.find((entry) => entry.id === "acme/main")?.metadataModelId).toBe(
      "gpt-5.5",
    );
  });

  it("global aliases and per-credential aliases merge with the credential winning, gemini is exempt", () => {
    const yaml = `
oauth:
  model-alias:
    claude:
      - { name: claude-sonnet-4-5-20250929, alias: sonnet, "display-name": Global }
      - { name: claude-sonnet-4-6, alias: s46 }
    gemini:
      - { name: gemini-2.5-pro, alias: pro }
`;

    const claude = assembleCredentialModels(
      source("a", "claude", {
        modelAliases: [
          { name: "claude-sonnet-4-5-20250929", alias: "sonnet", "display-name": "Mine" },
        ],
      }),
      options(yaml),
    );

    const sonnet = claude?.models.find((entry) => entry.id === "sonnet");
    expect(sonnet?.displayName).toBe("Mine");
    expect(ids(claude?.models)).toContain("s46");
    expect(ids(claude?.models)).not.toContain("claude-sonnet-4-6");
    const gemini = assembleCredentialModels(source("g", "gemini"), options(yaml));
    expect(ids(gemini?.models)).toContain("gemini-2.5-pro");
    expect(ids(gemini?.models)).not.toContain("pro");
  });

  it("oauth.settings max-context-length overrides the context length by name or alias, provider keys are exempt", () => {
    const yaml = `
oauth:
  model-alias:
    claude:
      - { name: claude-sonnet-4-6, alias: s46 }
  settings:
    claude:
      - { name: claude-sonnet-4-6, max-context-length: 123000 }
`;

    const oauth = assembleCredentialModels(source("a", "claude"), options(yaml));
    expect(oauth?.models.find((entry) => entry.id === "s46")).toMatchObject({
      contextLength: 123000,
      maxContextLength: 123000,
    });

    const apikey = assembleCredentialModels(
      source("k", "claude", { authKind: "apikey", source: "config" }),
      options(yaml),
    );

    expect(
      apikey?.models.find((entry) => entry.id === "claude-sonnet-4-6")?.contextLength,
    ).not.toBe(123000);
  });

  it("returns nothing for disabled credentials, unknown providers and fully excluded lists", () => {
    expect(
      assembleCredentialModels(source("a", "claude", { disabled: true }), options()),
    ).toBeUndefined();
    expect(assembleCredentialModels(source("a", "unknown-provider"), options())).toBeUndefined();
    expect(
      assembleCredentialModels(source("a", "claude", { excludedModels: ["*"] }), options()),
    ).toBeUndefined();
  });

  it("force-model-prefix hides the plain ids", () => {
    const assembled = assembleCredentialModels(
      source("a", "meta", { prefix: "m" }),
      options("routing:\n  force-model-prefix: true\n"),
    );

    expect(ids(assembled?.models).every((id) => id.startsWith("m/"))).toBe(true);
  });

  it("uses the active Devin catalog with built-ins", () => {
    const assembled = assembleCredentialModels(source("d", "devin"), options());
    expect(ids(assembled?.models)).toContain("devin/swe-1-6-slow");
  });
});

describe("assembleCredentialModels: provider keys", () => {
  it("replaces the catalog with the configured models (owner/type per family, static thinking inherited)", () => {
    const assembled = assembleCredentialModels(
      source("k", "claude", {
        authKind: "apikey",
        source: "config",
        excludedModels: ["hidden"],
        models: [
          {
            name: "claude-sonnet-4-6",
            alias: "sonnet",
            "display-name": "My Sonnet",
            "max-context-length": 500000,
          },
          { name: "claude-sonnet-4-6", alias: "SONNET" },
          { name: "hidden" },
          { name: "custom-model", thinking: { levels: ["Low", "none", "high"] } },
        ],
      }),
      options(),
    );

    expect(ids(assembled?.models)).toEqual(["sonnet", "custom-model"]);
    const [sonnet, custom] = assembled?.models ?? [];
    expect(sonnet).toMatchObject({
      ownedBy: "anthropic",
      type: "claude",
      displayName: "My Sonnet",
      metadataModelId: "claude-sonnet-4-6",
      created: 1_800_000_000,
      contextLength: 500000,
      maxContextLength: 500000,
      userDefined: true,
    });
    expect(sonnet?.thinking?.levels).toEqual(["low", "medium", "high", "max"]);
    expect(sonnet?.explicitThinking).toBeUndefined();
    expect(custom?.thinking).toEqual({ levels: ["low", "none", "high"], zeroAllowed: true });
    expect(custom?.explicitThinking).toBe(true);
  });

  it("Provider-key credentials without models use the provider catalog", () => {
    const assembled = assembleCredentialModels(
      source("k", "gemini", { authKind: "apikey", source: "config" }),
      options(),
    );

    expect(ids(assembled?.models)).toEqual(ids(sectionModels(catalogs, "gemini")));
  });

  it("codex provider key without models serves all codex-pro models without configuration updates", () => {
    const assembled = assembleCredentialModels(
      source("k", "codex", { authKind: "apikey", source: "config" }),
      options(),
    );

    expect(ids(assembled?.models)).toEqual(ids(sectionModels(catalogs, "codex-pro")));
    expect(assembled?.models.every((entry) => entry.supportConfigurationUpdate === false)).toBe(
      true,
    );
  });

  it("codex provider key models keep display names and configuration-update flags per alias", () => {
    const assembled = assembleCredentialModels(
      source("k", "codex", {
        authKind: "apikey",
        source: "config",
        models: [
          {
            name: "gpt-5.5",
            alias: "main",
            "display-name": "Main",
            "support-configuration-update": true,
          },
          { name: "gpt-6-sol" },
        ],
      }),
      options(),
    );

    expect(
      assembled?.models.map((entry) => [
        entry.id,
        entry.displayName,
        entry.supportConfigurationUpdate,
        entry.ownedBy,
      ]),
    ).toEqual([
      ["main", "Main", true, "openai"],
      ["gpt-6-sol", "gpt-6-sol", false, "openai"],
    ]);
  });

  it("OpenAI-compatibility: pools stay duplicated, image models drop default thinking, exclusions and aliases do not apply", () => {
    const assembled = assembleCredentialModels(
      source("c", "openai-compatible-acme", {
        authKind: "apikey",
        source: "config",
        label: "Acme",
        executor: "openai-compatible-acme",
        compat: true,
        prefix: "pfx",
        excludedModels: ["*"],
        modelAliases: [{ name: "gpt-x", alias: "renamed" }],
        models: [
          {
            name: "gpt-x",
            alias: "pool",
            "input-modalities": ["Text", "IMAGE", "text"],
            "output-modalities": ["text"],
          },
          { name: "gpt-y", alias: "pool", thinking: { levels: ["minimal"] } },
          { name: "img-1", image: true },
        ],
      }),
      options("routing:\n  force-model-prefix: true\n"),
    );

    expect(assembled?.provider).toBe("openai-compatible-acme");
    expect(ids(assembled?.models)).toEqual(["pfx/pool", "pfx/img-1"]);
    const [pool, image] = assembled?.models ?? [];
    expect(pool).toMatchObject({
      ownedBy: "Acme",
      type: "openai-compatibility",
      displayName: "pool",
      metadataModelId: "gpt-x",
      userDefined: false,
      supportedInputModalities: ["text", "image"],
      supportedOutputModalities: ["text"],
      explicitInputModalities: true,
    });
    expect(pool?.thinking).toEqual({ levels: ["low", "medium", "high"] });
    expect(image).toMatchObject({ type: "openai-image", metadataModelId: "img-1" });
    expect(image?.thinking).toBeUndefined();
  });

  it("OpenAI-compatibility keeps duplicate aliases when there is no prefix (counted as separate registrations)", () => {
    const assembled = assembleCredentialModels(
      source("c", "openai-compatible-acme", {
        authKind: "apikey",
        label: "Acme",
        executor: "openai-compatible-acme",
        compat: true,
        models: [
          { name: "a", alias: "pool" },
          { name: "b", alias: "pool" },
        ],
      }),
      options(),
    );

    expect(ids(assembled?.models)).toEqual(["pool", "pool"]);
  });

  it("OpenAI-compatibility without models registers nothing", () => {
    expect(
      assembleCredentialModels(
        source("c", "openai-compatible-acme", { compat: true, executor: "openai-compatible-acme" }),
        options(),
      ),
    ).toBeUndefined();
  });
});

describe("assembleCredentialModels: OpenCode Zen free models (ADR 0033)", () => {
  const zen = (cloakMode?: string) =>
    source("z", "opencode-zen", {
      authKind: "apikey",
      source: "config",
      ...(cloakMode === undefined ? {} : { cloakMode }),
    });

  const listed = (cloakMode?: string, yaml = "") =>
    ids(assembleCredentialModels(zen(cloakMode), options(yaml))?.models);

  it("registers the free models while the key cloaks them (auto by default, or always)", () => {
    expect(listed()).toContain("big-pickle");
    expect(listed("always")).toContain("big-pickle");
    expect(listed()).toContain("deepseek-v4-flash");
  });

  it("leaves them out with cloak.mode never or upstream.opencode.disable-cloaking", () => {
    expect(listed("never")).not.toContain("big-pickle");
    expect(listed("never")).toContain("deepseek-v4-flash");
    expect(listed(undefined, "upstream:\n  opencode:\n    disable-cloaking: true\n")).not.toContain(
      "big-pickle",
    );
  });
});
