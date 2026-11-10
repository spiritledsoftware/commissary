/**
 * Credentials synthesised from `api-keys.claude` config entries.
 *
 * Go source: internal/watcher/synthesizer/config.go (synthesizeClaudeKeys), sdk/cliproxy/service_models.go
 * (buildClaudeConfigModels). Only the config-only test stand-ins use it (`static-picker.ts`, `ModelProviders.configLayer`),
 * so only explicitly configured models are listed; production routing goes through the model registry
 * (`registry/credential-models.ts`), where keys without `models` serve the static Claude catalog like Go.
 */
import type { ProviderKeyGroup } from "../../config/schema.ts";
import type { ConfigCredential } from "../config-credentials.ts";

const headerAttributes = (
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(headers ?? {}).flatMap(([name, value]): Array<[string, string]> => {
      const key = name.trim();
      const val = value.trim();

      return key !== "" && val !== "" ? [[`header:${key}`, val]] : [];
    }),
  );
};

const modelIds = (
  group: ProviderKeyGroup,
  entryModels: ProviderKeyGroup["models"],
  prefix: string,
  forcePrefix: boolean,
): string[] => {
  const ids: string[] = [];

  const add = (id: string) => {
    if (id !== "" && !ids.includes(id)) ids.push(id);
  };

  for (const model of entryModels ?? group.models ?? []) {
    const id = (model.alias ?? "").trim() || model.name.trim();

    if (id === "") continue;

    if (prefix === "") {
      add(id);
      continue;
    }

    if (!forcePrefix || prefix === id) add(id);
    add(`${prefix}/${id}`);
  }

  return ids;
};

export const claudeConfigCredentials = (
  groups: ReadonlyArray<ProviderKeyGroup>,
  forceModelPrefix: boolean,
): ConfigCredential[] => {
  const out: ConfigCredential[] = [];
  groups.forEach((group, groupIndex) => {
    group.keys.forEach((entry, keyIndex) => {
      const providerKey = entry["api-key"].trim();

      if (providerKey === "") return;
      const prefix = (entry.prefix ?? group.prefix ?? "").trim();
      const priority = entry.priority ?? group.priority ?? 0;
      const profile = (entry["fingerprint-profile"] ?? "").trim().toLowerCase();

      const baseUrl = (group["base-url"] ?? "").trim();

      const attributes = {
        api_key: providerKey,
        auth_kind: "apikey",
        source: `config:claude[${groupIndex}.${keyIndex}]`,
        config_index: `${groupIndex}.${keyIndex}`,
        ...(priority !== 0 ? { priority: String(priority) } : {}),
        ...(entry.weight !== undefined ? { weight: String(entry.weight) } : {}),
        ...(profile !== "" ? { fingerprint_profile: profile } : {}),
        ...(entry["rebuild-mid-system-message"] === true
          ? { rebuild_mid_system_message: "true" }
          : {}),
        ...(entry["native-tool-search"] === true ? { native_tool_search: "true" } : {}),
        ...headerAttributes(group.headers),
        ...headerAttributes(entry.headers),
        ...(baseUrl !== "" ? { base_url: baseUrl } : {}),
      };

      out.push({
        credential: {
          id: `claude#${groupIndex}.${keyIndex}`,
          provider: "claude",
          kind: "apikey",
          label: "claude-apikey",
          ...(prefix !== "" ? { prefix } : {}),
          attributes,
          metadata: {},
        },
        models: new Set(modelIds(group, entry.models, prefix, forceModelPrefix)),
        priority,
      });
    });
  });

  return out;
};
