/**
 * Claude credential helpers, first-party detection, fingerprint and wire policies.
 *
 * Go source: internal/runtime/executor/claude_executor_request.go (claudeCreds, isClaudeOAuthToken,
 * claudeCredentialUsesOAuth, isAnthropicUpstreamBase), internal/runtime/executor/helps/claude_upstream.go,
 * claude_fingerprint_policy.go (resolveClaudeFingerprintPolicy), claude_executor_cloaking.go (getCloakConfigFromAuth,
 * resolveClaudeWirePolicy), claude_signing.go (resolveClaudeKeyConfig).
 */
import type { ClaudeCloakLevel } from "@commissary/contract/settings";
import type { ProviderKeyEntry, ProviderKeyGroup, Config } from "../../config/schema.ts";
import type { CredentialSnapshot } from "../picker.ts";

export const DEFAULT_BASE_URL = "https://api.anthropic.com";

export const FINGERPRINT_PROFILE_CLAUDE_CODE_CLI = "claude-code-cli";

/** `isClaudeOAuthToken`. */
export const isClaudeOAuthToken = (providerKey: string): boolean =>
  providerKey.includes("sk-ant-oat");

/** `IsAnthropicUpstreamURL`: https, `api.anthropic.com`, no userinfo, default port. */
export const isAnthropicUpstreamURL = (url: URL): boolean =>
  url.username === "" &&
  url.password === "" &&
  url.protocol === "https:" &&
  url.hostname.toLowerCase() === "api.anthropic.com" &&
  (url.port === "" || url.port === "443");

export const isAnthropicUpstreamBase = (baseURL: string): boolean => {
  try {
    return isAnthropicUpstreamURL(new URL(baseURL.trim()));
  } catch {
    return false;
  }
};

const metadataString = (credential: CredentialSnapshot, key: string): string => {
  const value = credential.metadata[key];

  return typeof value === "string" ? value.trim() : "";
};

/** `claudeCreds`: attributes first (`api_key`, `base_url`), then the OAuth access token. */
export const claudeCreds = (credential: CredentialSnapshot) => {
  const providerKey = credential.attributes["api_key"] ?? "";

  return {
    providerKey: providerKey !== "" ? providerKey : metadataString(credential, "access_token"),
    baseURL: credential.attributes["base_url"] ?? "",
  };
};

/** `claudeCredentialUsesOAuth`: OAuth token -> Bearer; provider-key credentials use `x-api-key` on first-party hosts. */
export const claudeCredentialUsesOAuth = (
  credential: CredentialSnapshot,
  providerKey: string,
): boolean => {
  if (isClaudeOAuthToken(providerKey)) return true;

  if (credential.kind === "apikey") return false;

  return (credential.attributes["api_key"] ?? "").trim() === "";
};

/** `resolveClaudeKeyConfig`: the `api-keys.claude` entry matching the credential's key (and base URL). */
export const resolveClaudeKeyConfig = (
  config: Config,
  credential: CredentialSnapshot,
):
  | { readonly entry: ProviderKeyEntry; readonly group: ProviderKeyGroup; readonly baseUrl: string }
  | undefined => {
  const { providerKey, baseURL } = claudeCreds(credential);

  if (providerKey === "") return undefined;

  for (const group of config["api-keys"].claude) {
    const groupBase = (group["base-url"] ?? "").trim();

    for (const entry of group.keys) {
      if (entry["api-key"].trim().toLowerCase() !== providerKey.toLowerCase()) continue;

      if (baseURL !== "" && groupBase !== "" && groupBase.toLowerCase() !== baseURL.toLowerCase())
        continue;

      return { entry, group, baseUrl: groupBase };
    }
  }

  return undefined;
};

/** Attribute first, then credential metadata (Go `lookupCloakAttr`). */
const lookupAttr = (credential: CredentialSnapshot, key: string): string => {
  const attribute = (credential.attributes[key] ?? "").trim();

  return attribute !== "" ? attribute : metadataString(credential, key);
};

export interface FingerprintPolicy {
  readonly authIsOAuthToken: boolean;
  readonly profileClaudeCodeCLI: boolean;
  readonly useOAuthBetas: boolean;
  readonly applyCLIIdentity: boolean;
  readonly synthesizeIdentity: boolean;
  readonly mcpAlias: boolean;
  readonly injectDiagnostics: boolean;
}

/** `resolveClaudeFingerprintPolicy`. */
export const resolveFingerprintPolicy = (
  config: Config,
  credential: CredentialSnapshot,
  providerKey: string,
): FingerprintPolicy => {
  const authIsOAuth = isClaudeOAuthToken(providerKey);

  let profile =
    lookupAttr(credential, "fingerprint_profile") || lookupAttr(credential, "fingerprint-profile");

  if (profile === "")
    profile = resolveClaudeKeyConfig(config, credential)?.entry["fingerprint-profile"] ?? "";
  const cli = authIsOAuth || profile.trim().toLowerCase() === FINGERPRINT_PROFILE_CLAUDE_CODE_CLI;

  return {
    authIsOAuthToken: authIsOAuth,
    profileClaudeCodeCLI: cli,
    useOAuthBetas: cli,
    applyCLIIdentity: cli,
    synthesizeIdentity: cli && !authIsOAuth,
    mcpAlias: cli,
    injectDiagnostics: cli,
  };
};

/**
 * How much of a cloaked request looks like Claude Code (GLOSSARY.md, "Cloak level"): `full` sends everything Claude Code sends,
 * `minimal` only what a Claude subscription checks (the caller system prompt out of the top-level `system`, the
 * Claude Code identity line, the OAuth beta). A Commissary addition: Go has only the cloak mode.
 */
export type CloakLevel = ClaudeCloakLevel;

/** Trimmed, case-insensitive; anything but `minimal` (including empty) is `full`. */
const parseCloakLevel = (value: string): CloakLevel | undefined => {
  const level = value.trim().toLowerCase();

  if (level === "") return undefined;

  return level === "minimal" ? "minimal" : "full";
};

export interface WirePolicy {
  readonly oauth: boolean;
  readonly profileClaudeCodeCLI: boolean;
  readonly confirmedClaudeCode: boolean;
  readonly cloak: boolean;
  /** Only meaningful when {@link cloak} is set. */
  readonly level: CloakLevel;
}

/** The request is cloaked at the `minimal` level: nothing of Claude Code's beyond what the subscription checks. */
export const isMinimalCloak = (policy: WirePolicy): boolean =>
  policy.cloak && policy.level === "minimal";

export interface CloakSettings {
  readonly strictMode: boolean;
  readonly sensitiveWords: ReadonlyArray<string>;
  readonly cacheUserID: boolean;
}

export interface WireResolution {
  readonly policy: WirePolicy;
  readonly settings: CloakSettings;
}

/** `resolveClaudeWirePolicy`: whether the request is cloaked as Claude Code CLI traffic. */
export const resolveWirePolicy = (
  config: Config,
  credential: CredentialSnapshot,
  providerKey: string,
  confirmedClaudeCode: boolean,
): WireResolution => {
  const cloakCfg = resolveClaudeKeyConfig(config, credential)?.entry.cloak;
  const attrMode = lookupAttr(credential, "cloak_mode");
  const attrStrict = lookupAttr(credential, "cloak_strict_mode").toLowerCase() === "true";
  const wordsText = lookupAttr(credential, "cloak_sensitive_words");
  const attrWords = wordsText === "" ? [] : wordsText.split(",").map((word) => word.trim());
  const attrCache = lookupAttr(credential, "cloak_cache_user_id").toLowerCase() === "true";
  const attrLevel = parseCloakLevel(lookupAttr(credential, "cloak_level"));

  let cloakMode = config.upstream.claude["disable-claude-cloak-mode"] ? "never" : "auto";
  let strictMode = attrStrict;
  let sensitiveWords: ReadonlyArray<string> = attrWords;
  let cacheUserID = attrCache;
  let level: CloakLevel = attrLevel ?? config.upstream.claude["cloak-level"];

  if (attrMode !== "") cloakMode = attrMode;

  if (cloakCfg !== undefined) {
    const mode = (cloakCfg.mode ?? "").trim();

    if (mode !== "") cloakMode = mode;

    if (cloakCfg["strict-mode"] === true) strictMode = true;

    if ((cloakCfg["sensitive-words"]?.length ?? 0) > 0)
      sensitiveWords = cloakCfg["sensitive-words"] ?? [];

    if (cloakCfg["cache-user-id"] !== undefined) cacheUserID = cloakCfg["cache-user-id"];

    level = parseCloakLevel(cloakCfg.level ?? "") ?? level;
  }

  const fp = resolveFingerprintPolicy(config, credential, providerKey);

  // The level says how much, never whether: a key's `cloak` object or attribute holding only a level does not count.
  const cloakCfgOnlyLevel =
    cloakCfg?.level !== undefined &&
    Object.entries(cloakCfg).every(([key, value]) => key === "level" || value === undefined);

  const cloakConfigured =
    (cloakCfg !== undefined && !cloakCfgOnlyLevel) ||
    attrMode !== "" ||
    attrStrict ||
    attrWords.length > 0 ||
    attrCache;

  let cloak = (fp.profileClaudeCodeCLI || cloakConfigured) && !confirmedClaudeCode;

  if (!confirmedClaudeCode) {
    const mode = cloakMode.trim().toLowerCase();

    if (mode === "always") cloak = true;
    else if (mode === "never") cloak = false;
  }

  return {
    policy: {
      oauth: fp.authIsOAuthToken,
      profileClaudeCodeCLI: fp.profileClaudeCodeCLI,
      confirmedClaudeCode,
      cloak,
      level,
    },
    settings: { strictMode, sensitiveWords, cacheUserID },
  };
};
