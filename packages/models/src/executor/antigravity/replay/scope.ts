/**
 * Replay session key of an Antigravity request.
 *
 * Go source: internal/runtime/executor/antigravity_reasoning_replay.go (`antigravityReasoningReplayScopeFromRequest`,
 * `…ClientSessionKey`, `antigravityClaudeReplaySystemLane`, `antigravityReplaySessionIDFromPayload`). The Go
 * execution-session metadata key does not exist on Workers. Workers addition: keys are namespaced by the caller
 * scope (like the xAI/Kimi/Claude stores) so two callers never share a ledger.
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
import { extractSessionInfo } from "../../../handlers/session.ts";
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

/** `antigravityClaudeReplaySystemLane`: a hash of the system prompt without cache markers. */
const claudeSystemLane = (payload: Json | undefined): string => {
  const system = get(payload, "system");

  if (system === undefined) return "";

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

const clientSessionKey = (input: ReplayScopeInput): string => {
  const bodies = [input.originalRequest, input.requestPayload];

  for (const raw of bodies) {
    const scope = claudeCodeExecutionScope(raw, input.headers);

    if (scope === undefined) continue;
    const lane = claudeSystemLane(raw);

    return lane === "" ? scope : `${scope}:context:${lane}`;
  }

  const header = headerValue(input.headers, "Session-Id", "Session_id");

  if (header !== "") return `responses:${header}`;

  for (const raw of bodies) {
    if (raw === undefined) continue;

    for (const path of ["session_id", "metadata.session_id"]) {
      const value = asString(get(raw, path)).trim();

      if (value !== "") return `responses:${value}`;
    }
  }

  for (const raw of bodies) {
    const value = asString(get(raw, "prompt_cache_key")).trim();

    if (value !== "") return `prompt-cache:${value}`;
  }

  // Explicit session aliases (ingress extraction) before the inferred root (80aa2b1d).
  const alias = extractSessionInfo(input.headers, undefined)?.sessionId ?? "";

  if (alias !== "") return `client:${alias}`;

  return input.derivedSessionId.trim() === "" ? "" : `derived:${input.derivedSessionId.trim()}`;
};

/** The session key of the request (empty when none can be derived), namespaced by the caller. */
export const replaySessionKey = (input: ReplayScopeInput, translatedPayload: Json): string => {
  // Prefer an explicit downstream session over one synthesised from request text, so identical prompts in separate
  // client sessions never share an opaque Gemini reasoning chain.
  const key =
    clientSessionKey(input) ||
    sessionKeyFromPayload(translatedPayload) ||
    sessionKeyFromPayload(input.requestPayload);

  const caller = input.callerScope.trim();

  if (key === "" || caller === "") return key;

  return `caller:${createHash("sha256").update(caller).digest("hex").slice(0, 16)}:${key}`;
};
