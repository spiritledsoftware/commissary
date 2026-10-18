/**
 * Claude upstream request headers (identity profile, `anthropic-beta`, auth).
 *
 * Go source: internal/runtime/executor/claude_executor_request.go (applyClaudeHeadersWithNativeProfile,
 * copyClaudeCallerFingerprintHeaders), helps/claude_device_profile.go (ApplyClaudeLegacyDeviceHeaders,
 * defaultClaudeDeviceProfile). Workers `fetch` cannot control header order or casing and the TLS fingerprint is
 * Cloudflare's (see README.md), so only names and values are reproduced. With `stabilize-device-profile` the
 * device headers come from the stabilised profile (`device-profile.ts`) instead of the legacy copy-or-baseline rules.
 * At the `minimal` cloak level (a Commissary addition) none of the CLI identity headers are sent.
 */
import { createHash } from "node:crypto";
import type { Config } from "../../config/schema.ts";
import { get, type JsonObject } from "@commissary/json";
import { str } from "@commissary/translation";
import { applyCustomHeaders } from "../helps/custom-headers.ts";
import type { CredentialSnapshot } from "../picker.ts";
import {
  BETA,
  claudeCodeCLIBetas,
  countTokensBetas,
  hasAdvisorTool,
  isManagedBeta,
  requestSupportsEffort,
  requestedBetas,
  withAdvisorToolBeta,
  withCountTokensOAuthBeta,
  withExtendedCacheTTLBeta,
  withOAuthCredentialBetas,
  withoutBeta,
} from "./betas.ts";
import { payloadHas1hTTL } from "./cache-control.ts";
import {
  isAnthropicUpstreamURL,
  claudeCredentialUsesOAuth,
  isMinimalCloak,
  type FingerprintPolicy,
  type WirePolicy,
} from "./credentials.ts";
import {
  DEFAULT_USER_AGENT,
  headerValue,
  isHaikuModel,
  isProbeOrHelperRequest,
  isSubagentRequest,
  plausibleClaudeCodeUserAgent,
  subagentRequests1h,
} from "./classify.ts";

const DEFAULT_PACKAGE_VERSION = "0.112.1";

const DEFAULT_RUNTIME_VERSION = "v26.3.0";

const DEFAULT_OS = "MacOS";

const DEFAULT_ARCH = "arm64";

const DEFAULT_TIMEOUT = "600";

export interface DeviceProfile {
  readonly userAgent: string;
  readonly packageVersion: string;
  readonly runtimeVersion: string;
  readonly os: string;
  readonly arch: string;
}

/** `defaultClaudeDeviceProfile`. */
export const defaultDeviceProfile = (config: Config): DeviceProfile => {
  const defaults = config.upstream.claude["header-defaults"];

  const pick = (value: string | undefined, fallback: string): string =>
    value !== undefined && value.trim() !== "" ? value.trim() : fallback;

  return {
    userAgent: pick(defaults["user-agent"], DEFAULT_USER_AGENT),
    packageVersion: pick(defaults["package-version"], DEFAULT_PACKAGE_VERSION),
    runtimeVersion: pick(defaults["runtime-version"], DEFAULT_RUNTIME_VERSION),
    os: pick(defaults.os, DEFAULT_OS),
    arch: pick(defaults.arch, DEFAULT_ARCH),
  };
};

/** Deterministic per-provider-key agent session id (Go caches a random UUID per key for an hour). */
export const cachedSessionId = (providerKey: string): string => {
  const hex = createHash("sha256").update(`cpa-claude-session|${providerKey}`).digest("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[Number.parseInt(hex.charAt(16), 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export interface HeaderInput {
  readonly config: Config;
  readonly credential: CredentialSnapshot;
  readonly providerKey: string;
  readonly url: URL;
  readonly stream: boolean;
  readonly countTokens: boolean;
  readonly extraBetas: readonly string[];
  /** Final upstream body (after payload rules). */
  readonly body: JsonObject;
  readonly incoming: Headers;
  readonly confirmedClaudeCode: boolean;
  readonly fingerprint: FingerprintPolicy;
  readonly wire: WirePolicy;
  /** Claude agent session UUID (empty when not known). */
  readonly sessionId: string;
  /** Session id for `$CPA-SESSION-ID` custom headers. */
  readonly cpaSessionId?: string | undefined;
  /**
   * `stabilize-device-profile` is on: confirmed Claude Code requests use `stabilizedProfile` (resolved by the pipeline),
   * everything else the configured baseline (`ApplyClaudeDeviceProfileHeaders` / `ApplyClaudeDefaultDeviceProfileHeaders`).
   */
  readonly stabilizeDeviceProfile?: boolean;
  readonly stabilizedProfile?: DeviceProfile | undefined;
}

const COPIED_PREFIXES = ["anthropic-", "x-stainless-", "x-claude-code-", "x-claude-remote-"];

const COPIED_NAMES = new Set([
  "accept",
  "accept-encoding",
  "user-agent",
  "x-app",
  "x-client-request-id",
  "x-client-app",
  "x-anthropic-additional-protection",
]);

/** `copyClaudeCallerFingerprintHeaders`. */
const copyCallerFingerprintHeaders = (
  target: Record<string, string>,
  source: Headers,
  confirmed: boolean,
): void => {
  source.forEach((value, name) => {
    const lower = name.toLowerCase();

    if (!COPIED_NAMES.has(lower) && !COPIED_PREFIXES.some((prefix) => lower.startsWith(prefix)))
      return;

    if (!confirmed && (lower.startsWith("x-claude-code-") || lower.startsWith("x-claude-remote-")))
      return;
    target[lower] = value;
  });
};

/** Builds the headers for a Messages / count_tokens request. */
export const buildClaudeHeaders = (input: HeaderInput) => {
  const {
    config,
    credential,
    providerKey,
    body,
    incoming,
    confirmedClaudeCode,
    countTokens,
    stream,
  } = input;

  const headers: Record<string, string> = {};
  const isAnthropicBase = isAnthropicUpstreamURL(input.url);
  const useAPIKey = !claudeCredentialUsesOAuth(credential, providerKey);
  const applyCLIFingerprint = input.fingerprint.profileClaudeCodeCLI || input.wire.cloak;
  const preserveCallerFingerprint = !applyCLIFingerprint && !confirmedClaudeCode;
  const useOAuthBetas = input.fingerprint.useOAuthBetas;
  // `minimal` cloak level: the betas the request needs (with the OAuth beta), but none of the CLI fingerprint.
  const minimalCloak = isMinimalCloak(input.wire);
  const defaults = config.upstream.claude["header-defaults"];

  if (providerKey.trim() !== "") {
    if (isAnthropicBase && useAPIKey) headers["x-api-key"] = providerKey;
    else headers["authorization"] = `Bearer ${providerKey}`;
  }

  headers["content-type"] = "application/json";

  const incomingBetas = (incoming.get("anthropic-beta") ?? "").trim();
  const requested = requestedBetas(incomingBetas, input.extraBetas);
  const advisorNeeded = requested.has(BETA.advisorTool) || hasAdvisorTool(body);

  let baseBetas = incomingBetas;

  if (!preserveCallerFingerprint) {
    baseBetas = claudeCodeCLIBetas(body, requested, useOAuthBetas);

    if (countTokens) {
      baseBetas = countTokensBetas(useOAuthBetas);

      if (advisorNeeded) baseBetas = withAdvisorToolBeta(baseBetas);
    }
  }

  if (confirmedClaudeCode && incomingBetas !== "") {
    baseBetas = incomingBetas;

    if (advisorNeeded) baseBetas = withAdvisorToolBeta(baseBetas);

    if (useOAuthBetas) {
      if (countTokens) {
        baseBetas = withCountTokensOAuthBeta(baseBetas);
      } else {
        const subagent = isSubagentRequest(incoming, body);
        const probe = isProbeOrHelperRequest(body);
        const includeExtended = (!subagent || subagentRequests1h(incoming, body)) && !probe;
        baseBetas = withOAuthCredentialBetas(baseBetas, includeExtended);
      }
    }
  } else if (preserveCallerFingerprint && useOAuthBetas) {
    baseBetas = countTokens
      ? withCountTokensOAuthBeta(baseBetas)
      : withOAuthCredentialBetas(baseBetas, false);
  }

  if (preserveCallerFingerprint && advisorNeeded) baseBetas = withAdvisorToolBeta(baseBetas);

  if (!requestSupportsEffort(body)) baseBetas = withoutBeta(baseBetas, BETA.effort);

  const existing = new Set(
    baseBetas
      .split(",")
      .map((beta) => beta.trim())
      .filter((beta) => beta !== ""),
  );

  const appendBeta = (raw: string): void => {
    const beta = raw.trim();

    if (beta === "" || existing.has(beta)) return;
    baseBetas = baseBetas.trim() === "" ? beta : `${baseBetas},${beta}`;
    existing.add(beta);
  };

  if (preserveCallerFingerprint) {
    if (str(body.speed).trim().toLowerCase() === "fast") appendBeta(BETA.fastMode);

    for (const beta of input.extraBetas) appendBeta(beta);
  } else {
    if (!confirmedClaudeCode && incomingBetas !== "") {
      for (const raw of incomingBetas.split(",")) {
        const beta = raw.trim();

        if (beta === "") continue;

        if (isManagedBeta(beta) && isAnthropicBase) continue;
        appendBeta(beta);
      }
    }

    if (!isAnthropicBase) for (const beta of input.extraBetas) appendBeta(beta);
  }

  const applyBetaHeader = (): void => {
    if (minimalCloak) baseBetas = withoutBeta(baseBetas, BETA.claudeCode);

    if (!requestSupportsEffort(body)) baseBetas = withoutBeta(baseBetas, BETA.effort);
    const probeOrHelper = isProbeOrHelperRequest(body);

    if (probeOrHelper) {
      baseBetas = withoutBeta(baseBetas, BETA.serverSideFallback);
      baseBetas = withoutBeta(baseBetas, BETA.thinkingDisplayUpdates);
      baseBetas = withoutBeta(baseBetas, BETA.extendedCacheTTL);
    }

    if (str(get(body, "thinking.type")) === "disabled") {
      baseBetas = withoutBeta(baseBetas, BETA.thinkingDisplayUpdates);
    }

    if (isSubagentRequest(incoming, body) && !subagentRequests1h(incoming, body)) {
      baseBetas = withoutBeta(baseBetas, BETA.extendedCacheTTL);
    }

    if (!probeOrHelper && !countTokens && payloadHas1hTTL(body))
      baseBetas = withExtendedCacheTTLBeta(baseBetas);

    if (isHaikuModel(str(body.model).trim()) && body.fallbacks === undefined) {
      baseBetas = withoutBeta(baseBetas, BETA.serverSideFallback);
    }

    if (baseBetas.trim() === "") delete headers["anthropic-beta"];
    else headers["anthropic-beta"] = baseBetas;
  };

  applyBetaHeader();

  const applyTransportNegotiation = (): void => {
    if (stream && !isAnthropicBase) {
      headers["accept"] = "text/event-stream";
      headers["accept-encoding"] = "identity";

      return;
    }

    headers["accept"] = "application/json";
    headers["accept-encoding"] = "gzip, deflate, br, zstd";
  };

  if (minimalCloak) {
    headers["anthropic-version"] = headerValue(incoming, "anthropic-version") || "2023-06-01";
    const userAgent = headerValue(incoming, "user-agent");

    if (userAgent !== "") headers["user-agent"] = userAgent;
    applyTransportNegotiation();
    applyCustomHeaders(headers, credential, incoming, input.cpaSessionId);

    if (isAnthropicBase) {
      applyBetaHeader();
      applyTransportNegotiation();
    } else if (stream) {
      applyTransportNegotiation();
    }

    return headers;
  }

  if (preserveCallerFingerprint) {
    let defaultAccept = "application/json";
    let defaultAcceptEncoding = "gzip, deflate, br, zstd";

    if (stream && !isAnthropicBase) {
      defaultAccept = "text/event-stream";
      defaultAcceptEncoding = "identity";
    }

    copyCallerFingerprintHeaders(headers, incoming, confirmedClaudeCode);

    const ensure = (name: string, fallback: string): void => {
      const value = headerValue(incoming, name);

      if (value !== "") headers[name] = value;
      else if ((headers[name] ?? "").trim() === "") headers[name] = fallback;
    };

    ensure("anthropic-version", "2023-06-01");
    ensure("accept", defaultAccept);
    ensure("accept-encoding", defaultAcceptEncoding);
    ensure("user-agent", "CLIProxyAPI/workers");
    applyBetaHeader();

    if (input.sessionId.trim() !== "") headers["x-claude-code-session-id"] = input.sessionId.trim();
    applyCustomHeaders(headers, credential, incoming, input.cpaSessionId);

    const restoreCallerTransport = (): void => {
      headers["accept"] = headerValue(incoming, "accept") || defaultAccept;
      headers["accept-encoding"] =
        headerValue(incoming, "accept-encoding") || defaultAcceptEncoding;
    };

    if (isAnthropicBase) {
      applyBetaHeader();
      restoreCallerTransport();
    } else if (stream) {
      restoreCallerTransport();
    }

    return headers;
  }

  const identity = (name: string, fallback: string): void => {
    if (confirmedClaudeCode) {
      const value = headerValue(incoming, name);

      if (value !== "") headers[name] = value;
      else if ((headers[name] ?? "").trim() === "") headers[name] = fallback;

      return;
    }

    headers[name] = fallback;
  };

  identity("anthropic-version", "2023-06-01");
  identity("anthropic-dangerous-direct-browser-access", "true");
  identity("x-app", "cli");
  identity("x-stainless-retry-count", "0");
  identity("x-stainless-runtime", "node");
  identity("x-stainless-lang", "js");

  if (confirmedClaudeCode && headerValue(incoming, "x-stainless-async") === "async")
    headers["x-stainless-async"] = "async";

  if (!countTokens) {
    const timeout = (defaults.timeout ?? "").trim();
    identity("x-stainless-timeout", timeout !== "" ? timeout : DEFAULT_TIMEOUT);
  } else if (confirmedClaudeCode) {
    const timeout = headerValue(incoming, "x-stainless-timeout");

    if (timeout !== "") headers["x-stainless-timeout"] = timeout;
  }

  const sessionId = input.sessionId.trim();

  if (sessionId !== "") headers["x-claude-code-session-id"] = sessionId;
  else identity("x-claude-code-session-id", cachedSessionId(providerKey));

  for (const name of [
    "x-claude-code-agent-id",
    "x-claude-code-parent-agent-id",
    "x-claude-remote-container-id",
    "x-claude-remote-session-id",
    "x-client-app",
    "x-anthropic-additional-protection",
  ]) {
    const value = headerValue(incoming, name);

    if (value !== "") headers[name] = value;
  }

  if (confirmedClaudeCode) {
    for (const name of [
      "x-claude-code-request-class",
      "x-claude-code-agent-type",
      "x-claude-code-prev-tool-durations",
      "x-claude-code-compaction",
      "x-claude-code-context-compacted",
    ]) {
      const value = headerValue(incoming, name);

      if (value !== "") headers[name] = value;
    }
  }

  if (isAnthropicBase) identity("x-client-request-id", crypto.randomUUID());
  headers["connection"] = "keep-alive";
  applyTransportNegotiation();

  const profile = defaultDeviceProfile(config);
  let usedIncomingUserAgent = false;

  if (input.stabilizeDeviceProfile === true) {
    const stabilized = confirmedClaudeCode ? (input.stabilizedProfile ?? profile) : profile;
    headers["user-agent"] = stabilized.userAgent;
    headers["x-stainless-package-version"] = stabilized.packageVersion;
    headers["x-stainless-runtime-version"] = stabilized.runtimeVersion;
    headers["x-stainless-os"] = stabilized.os;
    headers["x-stainless-arch"] = stabilized.arch;
    usedIncomingUserAgent = true;
  } else if (confirmedClaudeCode) {
    // Legacy device headers (`ApplyClaudeLegacyDeviceHeaders`).
    const ensureValid = (
      name: string,
      fallback: string,
      valid?: (value: string) => boolean,
    ): void => {
      const current = (headers[name] ?? "").trim();

      if (current !== "" && (valid === undefined || valid(current))) return;
      const fromIncoming = headerValue(incoming, name);

      if (fromIncoming !== "" && (valid === undefined || valid(fromIncoming))) {
        headers[name] = fromIncoming;

        return;
      }

      headers[name] = fallback;
    };

    ensureValid(
      "x-stainless-runtime-version",
      profile.runtimeVersion,
      (value) => value === profile.runtimeVersion,
    );
    ensureValid(
      "x-stainless-package-version",
      profile.packageVersion,
      (value) => value === profile.packageVersion,
    );
    ensureValid("x-stainless-os", profile.os);
    ensureValid("x-stainless-arch", profile.arch);
    const clientUserAgent = headerValue(incoming, "user-agent");

    if (plausibleClaudeCodeUserAgent(clientUserAgent, profile.userAgent)) {
      headers["user-agent"] = clientUserAgent;
      usedIncomingUserAgent = true;
    }
  }

  if (!usedIncomingUserAgent) {
    headers["x-stainless-runtime-version"] = profile.runtimeVersion;
    headers["x-stainless-package-version"] = profile.packageVersion;
    headers["x-stainless-os"] = profile.os;
    headers["x-stainless-arch"] = profile.arch;
    headers["user-agent"] = profile.userAgent;
  }

  applyCustomHeaders(headers, credential, incoming, input.cpaSessionId);

  if (isAnthropicBase) {
    headers["anthropic-beta"] = baseBetas;
    applyTransportNegotiation();
  } else if (stream) {
    applyTransportNegotiation();
  }

  return headers;
};
