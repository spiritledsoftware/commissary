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
   * so they are not registered unless listed in the config `models`, or the key cloaks them (`cloak.mode` other than
   * `never`, ADR 0033). Zen's System One models (catalog additions, ADR 0032), free or not, are registered all the
   * same.
   */
  readonly skipFreeModels: boolean;
}

export const OPENCODE_SPECS: Readonly<Record<OpenCodeProvider, OpenCodeProviderSpec>> = {
  [OPENCODE_ZEN]: {
    provider: OPENCODE_ZEN,
    baseUrl: "https://opencode.ai/inference/v1",
    catalogId: "opencode",
    displayName: "OpenCode Zen",
    skipFreeModels: true,
  },
  [OPENCODE_GO]: {
    provider: OPENCODE_GO,
    baseUrl: "https://opencode.ai/inference/go/v1",
    catalogId: "opencode-go",
    displayName: "OpenCode Go",
    skipFreeModels: false,
  },
};

export const isOpenCodeProvider = (provider: string): provider is OpenCodeProvider =>
  provider === OPENCODE_ZEN || provider === OPENCODE_GO;

/** `cloak.mode` of an OpenCode Zen key: `auto` cloaks free models, `always` every chat request, `never` none. */
export type OpenCodeCloakMode = "auto" | "always" | "never";

/** Credential attribute carrying the key's `cloak.mode` (set by the config credential synthesiser). */
export const CLOAK_MODE_ATTRIBUTE = "cloak_mode";

/** Reads a configured mode; anything but `always`/`never` (including unset) is `auto`. */
export const parseOpenCodeCloakMode = (value: string | undefined): OpenCodeCloakMode => {
  const mode = (value ?? "").trim().toLowerCase();

  return mode === "always" || mode === "never" ? mode : "auto";
};

/** The effective mode of a credential: OpenCode Go and the global switch are `never`; else the key's `cloak.mode`. */
export const openCodeCloakMode = (input: {
  readonly provider: string;
  readonly disabled: boolean;
  readonly mode: string | undefined;
}): OpenCodeCloakMode =>
  input.provider !== OPENCODE_ZEN || input.disabled ? "never" : parseOpenCodeCloakMode(input.mode);
