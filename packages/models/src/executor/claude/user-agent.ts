/**
 * The Claude Code `User-Agent`: `claude-cli/<version> (external, <entrypoint>[, <field>]...)`.
 *
 * Go source: internal/runtime/executor/helps/claude_code_user_agent.go (parseClaudeCodeUserAgent,
 * validClaudeCodeUserAgentFieldName). Real clients append `name/value` extension fields after the entrypoint
 * (`workload/cron`, `agent-sdk/0.2.133`, ...). Only `agent-sdk` is part of the client's stable identity; every other
 * field is opaque and belongs to the request it arrived on, so it never becomes a credential's stored device profile.
 * Parsing a valid UA does not make the client native: that is {@link detectClaudeCodeRequest}'s call.
 */

export type Version = readonly [number, number, number];

export interface ParsedUserAgent {
  readonly version: Version;
  /** Lower-cased entrypoint label (`cli`, `sdk-ts`, ...). */
  readonly entrypoint: string;
  /** The `agent-sdk/<version>` field, or "". */
  readonly agentSdkVersion: string;
  /** The UA without the request-only fields: the identity a device profile stores. */
  readonly profileUserAgent: string;
  /** Request-only extension fields as sent (leading blanks kept), in order. */
  readonly requestFields: readonly string[];
}

/** `claudePackageVersionPattern`. */
export const PACKAGE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** `claudeRuntimeVersionPattern`. */
export const RUNTIME_VERSION = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

/** Control characters other than a tab. */
const hasControlCharacter = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }

  return false;
};

// HTTP token characters: extension names use token syntax, values stay opaque.
const FIELD_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

const toVersion = (parts: readonly string[]): Version | undefined => {
  const numbers = parts.map(Number);

  return numbers.length === 3 && numbers.every(Number.isSafeInteger)
    ? [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0]
    : undefined;
};

/** `parseClaudeCLIVersion`: the leading `claude-cli/<major>.<minor>.<patch>` of a UA. */
export const parseCliVersion = (userAgent: string): Version | undefined => {
  const match = /^claude-cli\/(\d+)\.(\d+)\.(\d+)/.exec(userAgent.trim());

  return match === null ? undefined : toVersion(match.slice(1));
};

/** `parseClaudeSemver`: `x.y.z` with no prefix. */
export const parseSemver = (raw: string): Version | undefined => {
  const parts = raw.trim().split(".");

  return parts.length === 3 && parts.every((part) => /^\d+$/.test(part))
    ? toVersion(parts)
    : undefined;
};

export const compareVersions = (left: Version, right: Version): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) return difference > 0 ? 1 : -1;
  }

  return 0;
};

/**
 * `ApplyClaudeDeviceProfileHeaders`' User-Agent: the stabilised profile's identity with the request-only fields of this
 * request's own UA appended (`profileUserAgent` alone when either UA is not a well-formed Claude Code UA).
 */
export const withRequestFields = (profileUserAgent: string, requestUserAgent: string): string => {
  const stable = parseClaudeCodeUserAgent(profileUserAgent);
  const current = parseClaudeCodeUserAgent(requestUserAgent);

  if (stable === undefined || current === undefined) return profileUserAgent;

  return current.requestFields.length === 0
    ? stable.profileUserAgent
    : `${stable.profileUserAgent.slice(0, -1)},${current.requestFields.join(",")})`;
};

/** `parseClaudeCodeUserAgent`: `undefined` for anything that is not a well-formed Claude Code UA. */
export const parseClaudeCodeUserAgent = (raw: string): ParsedUserAgent | undefined => {
  if (hasControlCharacter(raw)) return undefined;
  const userAgent = raw.trim();
  const open = userAgent.indexOf("(");

  if (open < 0) return undefined;
  const prefix = userAgent.slice(0, open);
  const comment = userAgent.slice(open + 1);

  // The product must be followed by a blank before the comment.
  if (!comment.endsWith(")") || prefix === prefix.trim()) return undefined;
  const versionText = prefix.trim().startsWith("claude-cli/") ? prefix.trim().slice(11) : undefined;

  if (versionText === undefined || !PACKAGE_VERSION.test(versionText)) return undefined;
  const version = parseSemver(versionText);

  if (version === undefined) return undefined;
  const inner = comment.slice(0, -1);

  if (/[()]/.test(inner)) return undefined;
  const fields = inner.split(",");
  const first = fields[0] ?? "";

  if (fields.length < 2 || first.toLowerCase() !== "external") return undefined;
  const entrypointField = fields[1] ?? "";
  const entrypoint = entrypointField.trim().toLowerCase();

  if (entrypoint === "") return undefined;
  const stableFields = [first, entrypointField];
  const requestFields: string[] = [];
  const seen = new Set<string>();
  let agentSdkVersion = "";

  for (const field of fields.slice(2)) {
    const trimmed = field.trim();
    const slash = trimmed.indexOf("/");

    if (slash < 0) return undefined;
    const name = trimmed.slice(0, slash);
    const value = trimmed.slice(slash + 1);

    if (!FIELD_NAME.test(name) || value.trim() === "") return undefined;
    const key = name.toLowerCase();

    if (seen.has(key)) return undefined;
    seen.add(key);

    if (key === "agent-sdk") {
      if (!PACKAGE_VERSION.test(value)) return undefined;
      agentSdkVersion = value;
      stableFields.push(field);
    } else {
      requestFields.push(field);
    }
  }

  return {
    version,
    entrypoint,
    agentSdkVersion,
    // Request fields must never become a credential's stored device identity.
    profileUserAgent: requestFields.length > 0 ? `${prefix}(${stableFields.join(",")})` : userAgent,
    requestFields,
  };
};
