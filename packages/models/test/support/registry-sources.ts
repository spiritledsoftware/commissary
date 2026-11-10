/** Builders for registry tests: model sources, decoded configs and catalogs. */
import { Effect } from "effect";
import { parseConfigYaml } from "../../src/config/codec.ts";
import type { Config } from "../../src/config/schema.ts";
import { emptyState } from "../../src/credentials/model.ts";
import { embeddedCatalogs, type ModelCatalogs } from "../../src/registry/catalog.ts";
import type { AssemblyOptions } from "../../src/registry/credential-models.ts";
import { type ModelSource, toModelSource } from "../../src/registry/source.ts";

export const configOf = (yaml = ""): Config => Effect.runSync(parseConfigYaml(yaml));

export const NOW_SECONDS = 1_800_000_000;

export const options = (
  yaml = "",
  catalogs: ModelCatalogs = embeddedCatalogs(),
): AssemblyOptions => ({
  config: configOf(yaml),
  catalogs,
  nowSeconds: NOW_SECONDS,
});

export const source = (
  id: string,
  provider: string,
  overrides: Partial<ModelSource> = {},
): ModelSource => ({
  id,
  provider,
  executor: provider,
  source: "file",
  authKind: "oauth",
  label: id,
  disabled: false,
  compat: false,
  excludedModels: [],
  modelAliases: [],
  state: (({ rejectedAccessToken: _omitted, ...rest }) => rest)(emptyState()),
  ...overrides,
});

/**
 * A Claude provider key's model source, derived from its credential like the ControlPlane does (`toModelSource`):
 * `attributes` carry `base_url` and `native_tool_search`, so the origin bit comes from a real base URL.
 */
export const claudeKeySource = (
  id: string,
  attributes: Record<string, string> = {},
  overrides: Partial<ModelSource> = {},
): ModelSource => ({
  ...toModelSource(
    {
      id,
      provider: "claude",
      source: "config",
      authKind: "apikey",
      label: id,
      disabled: false,
      priority: 0,
      weight: 0,
      attributes: { api_key: "sk-ant-api03-test", ...attributes },
      metadata: {},
      headers: {},
      excludedModels: [],
      modelAliases: [],
      credentialVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    },
    emptyState(),
  ),
  ...overrides,
});

export const ids = (models: ReadonlyArray<{ readonly id: string }> | undefined): string[] =>
  (models ?? []).map((model) => model.id);
