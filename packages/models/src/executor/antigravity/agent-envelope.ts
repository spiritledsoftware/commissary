/**
 * The agent envelope of an Antigravity request: request and label ids correlated within one credential-scoped session,
 * like the native client sends them (CLIProxyAPI b8e3bc66, 38067a29).
 *
 * Go source: internal/runtime/executor/helps/antigravity_agent_envelope.go (`ApplyAntigravityAgentEnvelope`,
 * `antigravityAgentProgress`). The cascade and trajectory ids of a session live in per-isolate memory, as Go keeps them
 * in process memory: a new isolate starts a new cascade, which the upstream treats as a new conversation. Keys carry the
 * org, so two orgs never share one.
 */
import { randomUUID } from "node:crypto";
import { asString, get, isJsonArray, isJsonObject, type Json, set, del } from "@commissary/json";

interface AgentSession {
  readonly cascade: string;
  readonly trajectory: string;
  lastMillis: number;
}

const MAX_SESSIONS = 4096;

const sessions = new Map<string, AgentSession>();

const sessionFor = (key: string): AgentSession => {
  const existing = sessions.get(key);

  if (existing !== undefined) {
    // Least recently used order: a hit moves to the end.
    sessions.delete(key);
    sessions.set(key, existing);

    return existing;
  }

  const created: AgentSession = { cascade: randomUUID(), trajectory: randomUUID(), lastMillis: 0 };
  sessions.set(key, created);

  if (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;

    if (oldest !== undefined) sessions.delete(oldest);
  }

  return created;
};

/** Test hook: forgets every session's cascade. */
export const resetAgentSessions = (): void => sessions.clear();

/**
 * `antigravityAgentProgress`: model turns that generated something, and tool results (native tool results can carry
 * the model role; they are steps, not further model calls).
 */
interface AgentProgress {
  readonly turns: number;
  readonly results: number;
}

const agentProgress = (contents: Json | undefined): AgentProgress => {
  let turns = 0;
  let results = 0;

  if (!isJsonArray(contents)) return { turns, results };

  for (const content of contents) {
    const isModel = asString(get(content, "role")) === "model";
    let generated = false;
    const parts = get(content, "parts");

    if (!isJsonArray(parts)) continue;

    for (const part of parts) {
      if (
        isJsonObject(part) &&
        (part["functionResponse"] !== undefined || part["function_response"] !== undefined)
      ) {
        results++;
      } else if (isModel) generated = true;
    }

    if (generated) turns++;
  }

  return { turns, results };
};

export interface AgentEnvelopeInput {
  readonly org: string;
  readonly credentialId: string;
  readonly sessionId: string;
  readonly modelName: string;
  /** The upstream model enum of the selected model, when the catalog names one. */
  readonly modelEnum?: string;
  readonly now: number;
}

/** `ApplyAntigravityAgentEnvelope`: fills the request id and labels the request does not set itself. */
export const applyAgentEnvelope = (payload: Json, input: AgentEnvelopeInput): void => {
  const session = sessionFor(
    JSON.stringify([input.org, input.credentialId.trim(), input.sessionId]),
  );

  // Parallel requests for the same history stay distinct even within one millisecond.
  const stamp = Math.max(input.now, session.lastMillis + 1);
  session.lastMillis = stamp;
  const { turns, results } = agentProgress(get(payload, "request.contents"));
  const lastStep = turns + results;

  if (asString(get(payload, "requestId")).trim() === "") {
    set(
      payload,
      "requestId",
      `agent/${session.cascade}/${stamp}/${session.trajectory}/${lastStep + 1}`,
    );
  }

  const setIfEmpty = (path: string, value: string): void => {
    if (asString(get(payload, path)).trim() === "") set(payload, path, value);
  };

  setIfEmpty("request.labels.cascade_id", session.cascade);
  setIfEmpty("request.labels.root_cascade_id", session.cascade);
  setIfEmpty("request.labels.trajectory_id", session.trajectory);
  setIfEmpty("request.labels.request_id", `${session.trajectory}-${turns}`);
  setIfEmpty("request.labels.last_step_index", String(lastStep));

  const modelEnum = input.modelEnum ?? "";

  if (modelEnum !== "") set(payload, "request.labels.model_enum", modelEnum);
  else del(payload, "request.labels.model_enum");
  const model = input.modelName.toLowerCase();
  set(payload, "request.labels.used_claude", String(model.includes("claude")));
  set(payload, "request.labels.used_claude_conservative", "false");
  set(payload, "request.labels.used_non_gemini_model", String(!model.includes("gemini")));
};
