/**
 * Per-credential Antigravity model entitlements (`fetchAvailableModels`) applied to the static catalog.
 *
 * Go source: sdk/cliproxy/antigravity_models.go (`filterAntigravityModels`, `applyAntigravityFetchedModelCapabilities`,
 * `parseAntigravityModelCapabilityHints`). The cron task (`executor/antigravity/models.ts`) stores the probe result in KV;
 * the registry snapshot attaches it to the credential's `ModelSource`, and the executor reads its model enums and
 * thinking groups (`executor/antigravity/model-selection.ts`, CLIProxyAPI 2f86992c). Every field but
 * `webSearchModelIds` is optional, so records stored before a field existed still decode.
 */
import type { ModelInfo } from "./model-info.ts";

export interface AntigravityModelHints {
  /** Entitled model ids (lower-cased); `undefined` for legacy replies without `models` (never revokes a model). */
  readonly modelIds?: ReadonlyArray<string>;
  /** `webSearchModelIds` (lower-cased): these models get `supportsWebSearch`. */
  readonly webSearchModelIds: ReadonlyArray<string>;
  /** Exact upstream model id -> its model enum (`models.<id>.model`, Go `modelEnums`; b8e3bc66). */
  readonly modelEnums?: Readonly<Record<string, string>>;
  /**
   * Thinking group -> level -> output limit of the `<group>-<level>` member (`groupedModels`, Go `thinkingGroups`,
   * 2f86992c). A zero limit records a declared member that is not a switch target.
   */
  readonly thinkingGroups?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Exact ids of grouped members that can search the web (Go `thinkingWebSearch`). */
  readonly thinkingWebSearch?: ReadonlyArray<string>;
}

/** `normalizeAntigravityFetchedModelID`. */
export const normalizeFetchedModelId = (modelId: string): string => modelId.trim().toLowerCase();

/** The static list intersected with the entitlements, with web-search capability from the probe. */
export const applyAntigravityHints = (
  models: ModelInfo[],
  hints: AntigravityModelHints | undefined,
): ModelInfo[] => {
  if (hints === undefined) return models;
  const entitled = hints.modelIds === undefined ? undefined : new Set(hints.modelIds);
  const webSearch = new Set(hints.webSearchModelIds);
  const out: ModelInfo[] = [];

  for (const model of models) {
    const id = normalizeFetchedModelId(model.id);

    if (entitled !== undefined && !entitled.has(id)) continue;
    out.push(webSearch.has(id) ? { ...model, supportsWebSearch: true } : model);
  }

  return out;
};
