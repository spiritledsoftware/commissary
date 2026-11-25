/**
 * Claude credential helpers, first-party detection, fingerprint and wire policies.
 *
 * Go source: internal/runtime/executor/claude_executor_request.go (claudeCreds, isClaudeOAuthToken,
 * claudeCredentialUsesOAuth, isAnthropicUpstreamBase), internal/runtime/executor/helps/claude_upstream.go,
 * claude_fingerprint_policy.go (resolveClaudeFingerprintPolicy), claude_executor_cloaking.go (getCloakConfigFromAuth,
 * getCloakReplacementsFromAuth, getCloakPatternReplacementsFromAuth, resolveClaudeWirePolicy), claude_signing.go
 * (resolveClaudeKeyConfig).
 */
import { isJsonArray, isJsonObject, type Json, tryParseJson } from "@commissary/json";
import type { SensitivePatternRule } from "@commissary/contract/provider-keys";
import type { ClaudeCloakLevel } from "@commissary/contract/settings";
import { normalizeSensitiveWordsReplace } from "../../config/normalize.ts";
import {
  buildSensitiveWordMatcher,
  type SensitiveWordMatcher,
  type SensitiveWordSettings,
} from "../helps/cloak-obfuscate.ts";
import type { ProviderKeyEntry, ProviderKeyGroup, Config } from "../../config/schema.ts";
import type { CredentialSnapshot } from "../picker.ts";
import type { ClaudeCodeDetection } from "./classify.ts";

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
  /**
   * The mode resolved to `never` (the credential's `cloak_mode`/`cloak.mode`, or the global `disable-claude-cloak-mode`
   * when nothing is set per credential) and the credential is not one that already keeps the caller's headers: a
   * caller with the strong signals is confirmed whatever its entrypoint and keeps its own device headers.
   */
  readonly explicitNever: boolean;
  /** Only meaningful when {@link cloak} is set. */
  readonly level: CloakLevel;
}

/**
 * `isEffectiveConfirmedClaudeCode`: a confirmed native client, or (under `explicitNever`) any caller with the strong
 * signals, whatever its entrypoint.
 */
export const isEffectiveConfirmedClaudeCode = (
  detection: Pick<ClaudeCodeDetection, "confirmed" | "strongSignals">,
  policy: Pick<WirePolicy, "cloak" | "explicitNever">,
): boolean =>
  detection.confirmed || (!policy.cloak && policy.explicitNever && detection.strongSignals);

/** The request is cloaked at the `minimal` level: nothing of Claude Code's beyond what the subscription checks. */
export const isMinimalCloak = (policy: WirePolicy): boolean =>
  policy.cloak && policy.level === "minimal";

export interface CloakSettings {
  readonly strictMode: boolean;
  /** `sensitive-words`, `sensitive-words-replace` and `sensitive-patterns-replace`. */
  readonly sensitive: SensitiveWordSettings;
  readonly cacheUserID: boolean;
}

/** `claudeCloakSettings.buildSensitiveWordMatcher`: `undefined` when the credential configures nothing usable. */
export const cloakMatcher = (settings: CloakSettings): SensitiveWordMatcher | undefined =>
  buildSensitiveWordMatcher(settings.sensitive);

/** The string values of a JSON object, normalised (`NormalizeSensitiveWordsReplace`). */
const stringMapOf = (value: Json | undefined): Record<string, string> =>
  isJsonObject(value)
    ? normalizeSensitiveWordsReplace(
        Object.fromEntries(
          Object.entries(value).flatMap(([key, entry]) =>
            typeof entry === "string" ? [[key, entry]] : [],
          ),
        ),
      )
    : {};

/** The `{pattern, replacement}` objects of a JSON array whose pattern is text and not blank. */
const patternRulesOf = (value: Json | undefined): SensitivePatternRule[] =>
  isJsonArray(value)
    ? value.flatMap((item): SensitivePatternRule[] => {
        if (!isJsonObject(item) || typeof item["pattern"] !== "string") return [];
        const pattern = item["pattern"];
        const replacement = item["replacement"];

        return pattern.trim() === ""
          ? []
          : [{ pattern, replacement: typeof replacement === "string" ? replacement : "" }];
      })
    : [];

/** JSON text that starts with `open`, parsed; `undefined` otherwise. */
const jsonTextOf = (raw: string, open: "{" | "["): Json | undefined => {
  const trimmed = raw.trim();

  return trimmed.startsWith(open) ? tryParseJson(trimmed) : undefined;
};

/**
 * `getCloakReplacementsFromAuth` / `getCloakPatternReplacementsFromAuth`: the attribute `key` (JSON text starting
 * with `open`), else the metadata's JSON value, else the metadata's JSON text; the first that `parse` finds non-empty.
 */
const cloakJsonSetting = <A extends object>(
  credential: CredentialSnapshot,
  key: string,
  open: "{" | "[",
  parse: (value: Json | undefined) => A,
): A => {
  const metadata = credential.metadata[key];

  for (const value of [
    jsonTextOf(credential.attributes[key] ?? "", open),
    metadata,
    typeof metadata === "string" ? jsonTextOf(metadata, open) : undefined,
  ]) {
    const parsed = parse(value);

    if (Object.keys(parsed).length > 0) return parsed;
  }

  return parse(undefined);
};

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

  const attrWordsReplace = cloakJsonSetting(
    credential,
    "cloak_sensitive_words_replace",
    "{",
    stringMapOf,
  );

  const attrPatternsReplace = cloakJsonSetting(
    credential,
    "cloak_sensitive_patterns_replace",
    "[",
    patternRulesOf,
  );

  const attrCache = lookupAttr(credential, "cloak_cache_user_id").toLowerCase() === "true";
  const attrLevel = parseCloakLevel(lookupAttr(credential, "cloak_level"));

  let cloakMode = config.upstream.claude["disable-claude-cloak-mode"] ? "never" : "auto";
  let strictMode = attrStrict;
  let sensitiveWords: ReadonlyArray<string> = attrWords;
  let sensitiveWordsReplace: Readonly<Record<string, string>> = attrWordsReplace;
  let sensitivePatternsReplace: ReadonlyArray<SensitivePatternRule> = attrPatternsReplace;
  let cacheUserID = attrCache;
  let level: CloakLevel = attrLevel ?? config.upstream.claude["cloak-level"];
  let explicitMode = attrMode.trim().toLowerCase();

  if (attrMode !== "") cloakMode = attrMode;

  if (cloakCfg !== undefined) {
    const mode = (cloakCfg.mode ?? "").trim();

    if (mode !== "") {
      cloakMode = mode;
      explicitMode = mode.toLowerCase();
    }

    if (cloakCfg["strict-mode"] === true) strictMode = true;

    if ((cloakCfg["sensitive-words"]?.length ?? 0) > 0)
      sensitiveWords = cloakCfg["sensitive-words"] ?? [];

    if (Object.keys(cloakCfg["sensitive-words-replace"] ?? {}).length > 0)
      sensitiveWordsReplace = cloakCfg["sensitive-words-replace"] ?? {};

    if ((cloakCfg["sensitive-patterns-replace"]?.length ?? 0) > 0)
      sensitivePatternsReplace = cloakCfg["sensitive-patterns-replace"] ?? [];

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
    Object.keys(attrWordsReplace).length > 0 ||
    attrPatternsReplace.length > 0 ||
    attrCache;

  let cloak = (fp.profileClaudeCodeCLI || cloakConfigured) && !confirmedClaudeCode;
  const mode = cloakMode.trim().toLowerCase();

  // A credential that is not Claude Code CLI-profiled and sets `never` already keeps the caller's headers (Go `uncloak`).
  const uncloak =
    !fp.profileClaudeCodeCLI && (explicitMode === "never" || explicitMode === "uncloak");

  if (!confirmedClaudeCode) {
    if (mode === "always") cloak = true;
    else if (mode === "never") cloak = false;
  }

  return {
    policy: {
      oauth: fp.authIsOAuthToken,
      profileClaudeCodeCLI: fp.profileClaudeCodeCLI,
      confirmedClaudeCode,
      cloak,
      explicitNever: mode === "never" && !uncloak,
      level,
    },
    settings: {
      strictMode,
      sensitive: {
        words: sensitiveWords,
        replacements: sensitiveWordsReplace,
        patterns: sensitivePatternsReplace,
      },
      cacheUserID,
    },
  };
};
