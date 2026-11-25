/**
 * OAuth session state and provider name rules.
 *
 * Go source: internal/api/handlers/management/oauth_sessions.go (`ValidateOAuthState`, `NormalizeOAuthProvider`,
 * `NormalizeOAuthCallbackProvider`). Plugin providers do not exist on Workers.
 */

/** Canonical provider names of login sessions (Go: `anthropic`, not `claude`). */
export type OAuthProvider =
  | "anthropic"
  | "codex"
  | "antigravity"
  | "xai"
  | "copilot"
  | "devin"
  | "meta"
  | "kimi"
  | "kimi-ai";

const MAX_STATE_LENGTH = 128;

/** `ValidateOAuthState`: non-empty, at most 128 chars of `[A-Za-z0-9._-]`, no `..`. */
export const isValidOAuthState = (state: string): boolean => {
  const trimmed = state.trim();

  return (
    trimmed !== "" &&
    trimmed.length <= MAX_STATE_LENGTH &&
    !trimmed.includes("..") &&
    /^[A-Za-z0-9._-]+$/.test(trimmed)
  );
};

/** `NormalizeOAuthProvider`: the providers that use a callback or a device flow reachable through `/oauth/callback`. */
export const normalizeCallbackProvider = (provider: string): OAuthProvider | undefined => {
  switch (provider.trim().toLowerCase()) {
    case "anthropic":
    case "claude":
      return "anthropic";
    case "codex":
    case "openai":
      return "codex";
    case "antigravity":
    case "anti-gravity":
      return "antigravity";
    case "xai":
    case "x-ai":
    case "x.ai":
    case "grok":
      return "xai";
    case "devin":
    case "cognition":
      return "devin";
    case "meta":
    case "muse":
      return "meta";
    default:
      return undefined;
  }
};
