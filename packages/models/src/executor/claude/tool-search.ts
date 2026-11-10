/**
 * Native tool search: whether one attempt carries a Codex client's `tool_search` to Claude as deferred tools
 * (`defer_loading` + `tool_reference`).
 *
 * Go source: internal/runtime/executor/claude_executor.go (`SupportsNativeToolSearch`, `applyNativeToolSearchFallback`;
 * 52992659, 03a3cfec), kimi_executor.go. Deliberate differences (docs/ARCHITECTURE.md "Native tool search"): the gate
 * `upstream.claude.tool-search` is per org and read from the attempt's config snapshot, the decision is made once per
 * attempt (`commonContext`) and handed to the translators as an option instead of a process-wide switch plus a strip
 * pass, and a delegating profile (Kimi) is never native.
 */
import type { Config } from "../../config/schema.ts";
import type { CredentialSnapshot } from "../picker.ts";
import type { ModelInfo } from "../../registry/model-info.ts";
import type { ModelSource } from "../../registry/source.ts";
import { claudeModelLacksToolSearch } from "./classify.ts";
import { claudeCreds, isAnthropicUpstreamBase, resolveClaudeKeyConfig } from "./credentials.ts";
import type { ClaudeUpstreamProfile } from "./profile.ts";

/**
 * `SupportsNativeToolSearch` without the org gate: Anthropic's own origin qualifies (OAuth credentials, which have no
 * base URL, are Anthropic's own API), a custom base URL only with the key's `native-tool-search` (the
 * `native_tool_search` attribute or its config entry), and a model that predates tool search never does.
 */
export const credentialSupportsNativeToolSearch = (
  config: Config,
  credential: CredentialSnapshot,
  upstreamModel: string,
): boolean => {
  if (claudeModelLacksToolSearch(upstreamModel)) return false;
  const baseURL = claudeCreds(credential).baseURL.trim();

  if (baseURL === "" || isAnthropicUpstreamBase(baseURL)) return true;

  return (
    (credential.attributes["native_tool_search"] ?? "").trim().toLowerCase() === "true" ||
    resolveClaudeKeyConfig(config, credential)?.entry["native-tool-search"] === true
  );
};

/**
 * The catalog's per-credential bit: the org gate is on and the Claude credential qualifies for the model (its upstream
 * model after aliasing; a model source carries the credential's origin, not its attributes).
 */
export const sourceTakesNativeToolSearch = (
  config: Config,
  source: Pick<ModelSource, "executor" | "nativeToolSearchOrigin">,
  model: Pick<ModelInfo, "id" | "metadataModelId">,
): boolean =>
  config.upstream.claude["tool-search"] &&
  source.executor === "claude" &&
  source.nativeToolSearchOrigin === true &&
  !claudeModelLacksToolSearch(model.metadataModelId ?? model.id);

export interface NativeToolSearchInput {
  readonly config: Config;
  readonly credential: CredentialSnapshot;
  /** The delegating profile of a provider that reuses the Claude executor (Kimi); `undefined` for Claude itself. */
  readonly profile: ClaudeUpstreamProfile | undefined;
  /** The model sent upstream, after aliasing and a profile's rewrite. */
  readonly upstreamModel: string;
}

/** The per-attempt decision: the org gate is on, the plain Claude executor serves it, and the credential qualifies. */
export const nativeToolSearchFor = ({
  config,
  credential,
  profile,
  upstreamModel,
}: NativeToolSearchInput): boolean =>
  config.upstream.claude["tool-search"] &&
  profile === undefined &&
  credentialSupportsNativeToolSearch(config, credential, upstreamModel);
