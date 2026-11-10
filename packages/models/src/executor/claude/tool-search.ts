/**
 * Native tool search: whether one attempt carries a Codex client's `tool_search` to Claude as deferred tools
 * (`defer_loading` + `tool_reference`).
 *
 * Go source: internal/runtime/executor/claude_executor.go (`SupportsNativeToolSearch`, `applyNativeToolSearchFallback`;
 * 52992659, 03a3cfec), kimi_executor.go. Deliberate differences (docs/ARCHITECTURE.md "Native tool search"): the gate
 * `upstream.claude.tool-search` is per org and read from the attempt's config snapshot, the decision is made once per
 * attempt (`commonContext`) and handed to the translators as an option instead of a process-wide switch plus a strip
 * pass, a delegating profile (Kimi) is never native, and the key's flag is the `native_tool_search` attribute alone
 * (synthesised from the `native-tool-search` key field, or set on an account's auth file; Go also reads the config entry).
 * The catalog (`registry/native-tool-search.ts`) applies the same two predicates below, so it and the executor agree.
 */
import type { Config } from "../../config/schema.ts";
import type { CredentialSnapshot } from "../picker.ts";
import { claudeModelLacksToolSearch } from "./classify.ts";
import { claudeCreds, isAnthropicUpstreamBase } from "./credentials.ts";
import type { ClaudeUpstreamProfile } from "./profile.ts";

/**
 * Whether a Claude credential's origin takes native tool search, whatever the model: Anthropic's own API (no base URL,
 * which is how OAuth credentials are, or `api.anthropic.com`), or a custom `base-url` whose key carries the
 * `native_tool_search` attribute. Anthropic's docs do not cover third-party gateways, hence the opt-in.
 */
export const nativeToolSearchOrigin = (
  baseUrl: string,
  nativeToolSearchAttribute: string | undefined,
): boolean =>
  baseUrl.trim() === "" ||
  isAnthropicUpstreamBase(baseUrl) ||
  (nativeToolSearchAttribute ?? "").trim().toLowerCase() === "true";

/** `SupportsNativeToolSearch` without the org gate: the credential's origin, and a model that does not predate tool search. */
export const credentialSupportsNativeToolSearch = (
  credential: CredentialSnapshot,
  upstreamModel: string,
): boolean =>
  !claudeModelLacksToolSearch(upstreamModel) &&
  nativeToolSearchOrigin(
    claudeCreds(credential).baseURL,
    credential.attributes["native_tool_search"],
  );

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
  credentialSupportsNativeToolSearch(credential, upstreamModel);
