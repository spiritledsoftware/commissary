/**
 * The two OpenCode gateways (OpenCode Zen and OpenCode Go): provider keys, default endpoints and catalog ids.
 *
 * Deliberate deviation from Go: CLIProxyAPI has no OpenCode provider (OpenCode is reached through an
 * `openai-compatibility` entry there). See docs/ARCHITECTURE.md "OpenCode Zen and OpenCode Go".
 * Dependency-free so config, credential synthesis, the registry and the management API can share it.
 */

export const OPENCODE_ZEN = "opencode-zen";

export const OPENCODE_GO = "opencode-go";

export type OpenCodeProvider = typeof OPENCODE_ZEN | typeof OPENCODE_GO;

export const OPENCODE_PROVIDER_KEYS: ReadonlyArray<OpenCodeProvider> = [OPENCODE_ZEN, OPENCODE_GO];

export interface OpenCodeProviderSpec {
  /** Executor/registry key, also the `api-keys` family name. */
  readonly provider: OpenCodeProvider;
  /** Default `base-url`. */
  readonly baseUrl: string;
  /** Provider id in the models.dev catalog (`https://models.dev/api.json`). */
  readonly catalogId: "opencode" | "opencode-go";
  /** Human-readable name (`owned_by`, panel). */
  readonly displayName: string;
  /**
   * Free catalog models (cost input and output both 0) answer 403 `FreeTierError` outside OpenCode's own client on Zen,
   * so they are not registered unless listed in the config `models`. Zen's System One models (catalog additions,
   * ADR 0032), free or not, are registered all the same.
   */
  readonly skipFreeModels: boolean;
}

export const OPENCODE_SPECS: Readonly<Record<OpenCodeProvider, OpenCodeProviderSpec>> = {
  [OPENCODE_ZEN]: {
    provider: OPENCODE_ZEN,
    baseUrl: "https://opencode.ai/zen/v1",
    catalogId: "opencode",
    displayName: "OpenCode Zen",
    skipFreeModels: true,
  },
  [OPENCODE_GO]: {
    provider: OPENCODE_GO,
    baseUrl: "https://opencode.ai/zen/go/v1",
    catalogId: "opencode-go",
    displayName: "OpenCode Go",
    skipFreeModels: false,
  },
};

export const isOpenCodeProvider = (provider: string): provider is OpenCodeProvider =>
  provider === OPENCODE_ZEN || provider === OPENCODE_GO;
