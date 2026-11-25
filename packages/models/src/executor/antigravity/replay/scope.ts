/**
 * Replay session key of an Antigravity request.
 *
 * Go source: internal/runtime/executor/antigravity_reasoning_replay.go (`antigravityReasoningReplayScopeFromRequest`,
 * `…ClientSessionKey`, `antigravityClaudeReplaySystemLane`, `antigravityReplaySessionIDFromPayload`, and the
 * canonical and body session identities of CLIProxyAPI 3988a389: `antigravityFormatCanonicalReplaySessionKey`,
 * `antigravityReplayBodyAgentID`, `antigravityCodexQualifiedSessionKey`, `antigravityReplayHasForkIndicator`). The Go
 * execution-session metadata key does not exist on Workers, and the canonical session is the request's explicit one
 * (`metadata.sessionId`; Commissary has no LCP-reconciled canonical id in the metadata). Workers addition: keys are
 * namespaced by the caller scope (like the xAI/Kimi/Claude stores) so two callers never share a ledger.
 */
import { createHash } from "node:crypto";
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  stableStringify,
} from "@commissary/json";
import { isClaudeCodeAttributionSystemText } from "@commissary/translation";
import {
  claudeMetadataIdentities,
  extractSessionInfo,
  normalizeExplicitId,
} from "../../../handlers/session.ts";
import { boundSessionIdentity } from "../../../session-routing/identity.ts";
import { claudeCodeExecutionScope } from "../../codex/replay.ts";
import { stableSessionId } from "../envelope.ts";

export interface ReplayScopeInput {
  readonly modelName: string;
  /** The client body before translation (`opts.OriginalRequest`), when different from `payload`. */
  readonly originalRequest: Json | undefined;
  /** The client body the executor received (`req.Payload`). */
  readonly requestPayload: Json;
  readonly headers: Headers;
  /** Derived session id of the request (`helps.DerivedSessionID`). */
  readonly derivedSessionId: string;
  /** The request's explicit session identity (`metadata.sessionId`, Go `CanonicalSessionIDMetadataKey`), or `""`. */
  readonly canonicalSessionId: string;
  readonly callerScope: string;
}

const stripCacheControl = (value: Json): Json => {
  if (isJsonArray(value)) return value.map(stripCacheControl);

  if (isJsonObject(value)) {
    const out: Record<string, Json> = {};

    for (const [key, child] of Object.entries(value)) {
      if (key.trim().toLowerCase() === "cache_control") continue;
      out[key] = stripCacheControl(child);
    }

    return out;
  }

  return value;
};

/** `antigravityClaudeReplayIsAttributionBlock`. */
const isAttributionBlock = (value: Json): boolean =>
  isJsonObject(value) &&
  value.type === "text" &&
  typeof value.text === "string" &&
  isClaudeCodeAttributionSystemText(value.text);

/**
 * `antigravityClaudeReplaySystemLane`: a hash of the system prompt without cache markers. The Claude Code attribution
 * block changes on every request (`cch`, `cc_prompt_id`), so it is left out, and a system of only that block has no lane
 * (CLIProxyAPI bba22ed9).
 */
const claudeSystemLane = (payload: Json | undefined): string => {
  let system = get(payload, "system");

  if (system === undefined) return "";

  if (typeof system === "string" && isClaudeCodeAttributionSystemText(system)) return "";

  if (isJsonArray(system)) {
    const kept = system.filter((block) => !isAttributionBlock(block));

    if (kept.length === 0 && system.length > 0) return "";
    system = kept;
  }

  return createHash("sha256")
    .update(stableStringify(stripCacheControl(system)))
    .digest("hex")
    .slice(0, 32);
};

const headerValue = (headers: Headers, ...names: string[]): string => {
  for (const name of names) {
    const value = (headers.get(name) ?? "").trim();

    if (value !== "") return value;
  }

  return "";
};

const sessionIdFromPayload = (payload: Json | undefined): string => {
  if (payload === undefined) return "";

  for (const path of ["sessionId", "session_id", "request.sessionId", "request.session_id"]) {
    const id = asString(get(payload, path)).trim();

    if (id !== "") return id;
  }

  return "";
};

/** `antigravityReasoningReplayScopeFromPayload`: a session id in the payload or the stable one of its first turn. */
const sessionKeyFromPayload = (payload: Json | undefined): string => {
  if (payload === undefined) return "";
  let sessionId = sessionIdFromPayload(payload);

  if (sessionId === "") {
    const stable = stableSessionId(payload).trim();

    if (stable !== "") sessionId = stable.replace(/^-/, "") || stable;
  }

  return sessionId === "" ? "" : `session:${sessionId}`;
};

/** `antigravityReplayRawPayloads`: the client bodies, the received one only when it differs from the original. */
const rawPayloads = (input: ReplayScopeInput): Json[] => {
  const { originalRequest, requestPayload } = input;

  if (originalRequest === undefined) return [requestPayload];

  if (
    originalRequest === requestPayload ||
    stableStringify(originalRequest) === stableStringify(requestPayload)
  )
    return [originalRequest];

  return [originalRequest, requestPayload];
};

/** `antigravityIsLowPriorityCanonicalSession`. */
const isLowPriority = (id: string): boolean =>
  id.startsWith("pck:") ||
  id.startsWith("execution:") ||
  id.startsWith("user:") ||
  id.startsWith("derived:");

const KEY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["session:", "session:"],
  ["pck:", "prompt-cache:"],
  ["execution:", "execution:"],
  ["derived:", "derived:"],
];

/** `antigravityFormatCanonicalReplaySessionKey`. */
const canonicalReplayKey = (raw: string): string => {
  const id = raw.trim();

  if (id === "" || id.startsWith("user:")) return "";

  for (const [prefix, keyPrefix] of KEY_PREFIXES) {
    if (!id.startsWith(prefix)) continue;
    const value = id.slice(prefix.length).trim();

    return value === "" ? "" : `${keyPrefix}${value}`;
  }

  return `client:${id}`;
};

const MAIN_AGENT = "main";

const explicitAgent = (value: string): string => {
  const id = normalizeExplicitId(value);

  return id === MAIN_AGENT ? "" : id;
};

/** `antigravityReplayBodyAgentID`: a subagent id of the body, else of the agent headers. */
const bodyAgentId = (headers: Headers | undefined, raw: Json | undefined): string => {
  for (const path of ["metadata.agent_id", "metadata.subagent_id"]) {
    const id = explicitAgent(asString(get(raw, path)));

    if (id !== "") return id;
  }

  for (const name of ["X-Claude-Code-Agent-Id", "x-agent-id"]) {
    const id = headers === undefined ? "" : explicitAgent(headerValue(headers, name));

    if (id !== "") return id;
  }

  if (get(raw, "request") !== undefined && get(raw, "contents") === undefined) {
    for (const path of ["request.metadata.agent_id", "request.metadata.subagent_id"]) {
      const id = explicitAgent(asString(get(raw, path)));

      if (id !== "") return id;
    }
  }

  return "";
};

/** `antigravityReplayClaudeBodyAgentID`. */
const claudeBodyAgentId = (raw: Json | undefined): string =>
  bodyAgentId(undefined, raw) || explicitAgent(claudeMetadataIdentities(raw).agentId);

/** `antigravityExtractReplaySessionInfo` over the bodies (Go's metadata maps have no Workers counterpart). */
const extractedSessionId = (headers: Headers, payloads: ReadonlyArray<Json>): string => {
  for (const raw of payloads) {
    const id = extractSessionInfo(headers, raw)?.sessionId ?? "";

    if (id !== "") return id;
  }

  return "";
};

const CODEX_QUALIFIER_HEADERS = [
  "Thread-Id",
  "Thread_id",
  "X-Codex-Turn-Metadata",
  "X-Openai-Subagent",
  "X-Codex-Parent-Thread-Id",
];

const CODEX_QUALIFIER_PATHS = [
  "thread_id",
  "threadId",
  "metadata.thread_id",
  "request.thread_id",
  "request.threadId",
  "request.metadata.thread_id",
  "forked_from_thread_id",
  "forked_from_id",
  "metadata.forked_from_thread_id",
  "metadata.forked_from_id",
  "extra_body.forked_from_thread_id",
  "extra_body.forked_from_id",
  "request.metadata.forked_from_thread_id",
  "request.metadata.forked_from_id",
  "request.extra_body.forked_from_thread_id",
  "request.extra_body.forked_from_id",
];

/** `antigravityHasCodexSessionQualifier`. */
const hasCodexQualifier = (headers: Headers, payloads: ReadonlyArray<Json>): boolean =>
  headerValue(headers, ...CODEX_QUALIFIER_HEADERS) !== "" ||
  payloads.some((raw) =>
    CODEX_QUALIFIER_PATHS.some((path) => asString(get(raw, path)).trim() !== ""),
  );

/** `antigravityCodexQualifiedSessionKey`: a Codex thread or subagent of one `Session-Id` keeps its own key. */
const codexQualifiedKey = (
  headers: Headers,
  payloads: ReadonlyArray<Json>,
  canonicalId: string,
  sessionHeader: string,
): string => {
  const base = boundSessionIdentity(`codex:${sessionHeader}`);

  if (canonicalId !== "")
    return canonicalId.startsWith("codex:") && canonicalId !== base ? `client:${canonicalId}` : "";

  if (!hasCodexQualifier(headers, payloads)) return "";
  const extracted = extractedSessionId(headers, payloads);

  return extracted.startsWith("codex:") && extracted !== base ? `client:${extracted}` : "";
};

const FORK_INDICATOR_PATHS = [
  "forked_from_thread_id",
  "forked_from_id",
  "forkSource.sessionId",
  "fork_source.session_id",
  "previousSessionId",
  "previous_session_id",
  "metadata.forked_from_thread_id",
  "metadata.forked_from_id",
  "metadata.forkSource.sessionId",
  "metadata.fork_source.session_id",
  "metadata.previousSessionId",
  "metadata.previous_session_id",
  "extra_body.forked_from_thread_id",
  "extra_body.forked_from_id",
  "extra_body.forkSource.sessionId",
  "extra_body.fork_source.session_id",
  "extra_body.previousSessionId",
  "extra_body.previous_session_id",
];

/** `antigravityBytesHasForkIndicator`. */
const hasForkIndicator = (raw: Json | undefined): boolean => {
  if (raw === undefined) return false;
  const nested = get(raw, "request") !== undefined && get(raw, "contents") === undefined;

  return FORK_INDICATOR_PATHS.some(
    (path) =>
      normalizeExplicitId(asString(get(raw, path))) !== "" ||
      (nested && normalizeExplicitId(asString(get(raw, `request.${path}`))) !== ""),
  );
};

const clientSessionKey = (input: ReplayScopeInput): string => {
  const { headers } = input;
  const payloads = rawPayloads(input);

  for (const raw of payloads) {
    let scope = claudeCodeExecutionScope(raw, headers);

    if (scope === undefined) continue;

    // A subagent named in the body keeps its own lane under the main agent's session (3988a389).
    if (scope.endsWith(`:agent:${MAIN_AGENT}`)) {
      const agent = claudeBodyAgentId(raw);

      if (agent !== "") scope = `${scope.slice(0, -MAIN_AGENT.length)}${agent}`;
    }

    const lane = claudeSystemLane(raw);

    return lane === "" ? scope : `${scope}:context:${lane}`;
  }

  const canonicalId = input.canonicalSessionId.trim();
  const header = headerValue(headers, "Session-Id", "Session_id");

  if (header !== "")
    return codexQualifiedKey(headers, payloads, canonicalId, header) || `responses:${header}`;

  for (const raw of payloads) {
    for (const path of ["session_id", "metadata.session_id"]) {
      const value = asString(get(raw, path)).trim();

      if (value === "") continue;
      let effective = canonicalId;

      if (effective === "" || isLowPriority(effective)) {
        effective = extractedSessionId(headers, payloads) || effective;
      }

      if (
        effective !== "" &&
        effective !== boundSessionIdentity(`session:${value}`) &&
        !isLowPriority(effective)
      ) {
        const key = canonicalReplayKey(effective);

        if (key !== "") return key;
      }

      const agent = bodyAgentId(headers, raw);

      if (agent !== "") return boundSessionIdentity(`session:${value}:agent:${agent}`);

      return `responses:${value}`;
    }
  }

  // The canonical or ingress-extracted identity (body subagent, task, thread, conversation) before the weaker keys.
  const resolved = canonicalId || extractedSessionId(headers, payloads);

  if (resolved !== "" && !isLowPriority(resolved)) {
    const key = canonicalReplayKey(resolved);

    if (key !== "") return key;
  }

  if (resolved.startsWith("execution:") || resolved.startsWith("pck:")) {
    const key = canonicalReplayKey(resolved);

    if (key !== "") return key;
  }

  for (const raw of payloads) {
    const value = asString(get(raw, "prompt_cache_key")).trim();

    if (value !== "") return `prompt-cache:${value}`;
  }

  if (resolved.startsWith("derived:")) {
    const key = canonicalReplayKey(resolved);

    if (key !== "") return key;
  }

  return input.derivedSessionId.trim() === "" ? "" : `derived:${input.derivedSessionId.trim()}`;
};

/** The session key of the request (empty when none can be derived), namespaced by the caller. */
export const replaySessionKey = (input: ReplayScopeInput, translatedPayload: Json): string => {
  // Prefer an explicit downstream session over one synthesised from request text, so identical prompts in separate
  // client sessions never share an opaque Gemini reasoning chain.
  let key = clientSessionKey(input);

  if (key === "") {
    // A fork without an identifiable child session replays nothing rather than its parent's chain (3988a389).
    const forked = rawPayloads(input).some(hasForkIndicator) || hasForkIndicator(translatedPayload);

    if (forked) {
      const id =
        sessionIdFromPayload(translatedPayload) || sessionIdFromPayload(input.requestPayload);

      key = id === "" ? "" : `session:${id}`;
    } else {
      key = sessionKeyFromPayload(translatedPayload) || sessionKeyFromPayload(input.requestPayload);
    }
  }

  const caller = input.callerScope.trim();

  if (key === "" || caller === "") return key;

  return `caller:${createHash("sha256").update(caller).digest("hex").slice(0, 16)}:${key}`;
};
