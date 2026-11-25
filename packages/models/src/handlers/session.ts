/**
 * Session identity extraction for session affinity (`routing.session-affinity`).
 *
 * Go source: sdk/cliproxy/session/info.go (ExtractSessionInfo, isBodyForkCandidate, BoundSessionIdentity,
 * finalizeSessionInfo), sdk/cliproxy/session/identity.go (NormalizeExplicitID, ClaudeMetadataIdentities, CallerScope).
 * Docs: credentials.md §6.9. Only *explicit* identities are extracted (headers, body fields, Claude `metadata.user_id`);
 * requests without any session marker get the derived content-hash identity and the LCP conversation matcher from
 * `src/session-routing`.
 *
 * Deviation from Go: `X-Opencode-Session` (sent by OpenCode and pi for OpenCode Zen/Go) is an explicit identity in the
 * `X-Session-Affinity` slot (`affinity:<id>`, client type `opencode`); Go ignores it and derives a content hash.
 */
import { type Json, get } from "@commissary/json";

export interface SessionInfo {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly agentName: string;
  readonly clientType: string;
  readonly isFork: boolean;
  readonly isSubagent: boolean;
}

/**
 * `isGuardianRequest` (CLIProxyAPI 2f6f2924): a Codex Guardian review, by its `X-Openai-Subagent: guardian` header
 * (case and surrounding whitespace ignored), deliberately not by the review model, which is configurable.
 */
export const isGuardianRequest = (headers: Headers): boolean =>
  (headers.get("x-openai-subagent") ?? "").trim().toLowerCase() === "guardian";

const encoder = new TextEncoder();

/** `NormalizeExplicitID`: printable, trimmed, at most 256 bytes. */
export const normalizeExplicitId = (raw: string | undefined): string => {
  if (raw === undefined) return "";

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) return "";
  const trimmed = raw.trim();

  return trimmed === "" || encoder.encode(trimmed).length > 256 ? "" : trimmed;
};

/**
 * `encodeSessionSegment` (CLIProxyAPI f9ac9ffc): escapes the reserved `:agent:` delimiter, so a raw session id that
 * contains it cannot collide with a composed `<sid>:agent:<agent>` id. Ordinary ids are left as they are.
 */
export const encodeSessionSegment = (raw: string): string =>
  raw.includes(":agent")
    ? raw.replace(/:agent([~:])/g, (_match, next: string) =>
        next === "~" ? ":agent~~" : ":agent~;",
      )
    : raw;

const legacyClaudeSession =
  /_session_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

interface ClaudeIdentities {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly agentId: string;
}

export const stringOf = (value: Json | undefined): string =>
  typeof value === "string" ? value : "";

export interface RequestRoot {
  root: Json | undefined;
  nested: Json | undefined;
}

export const requestRoot = (body: Json | undefined): RequestRoot => {
  if (body === undefined) return { root: undefined, nested: undefined };
  const request = get(body, "request");
  const hasNested = request !== undefined && get(body, "contents") === undefined;

  return { root: body, nested: hasNested ? request : undefined };
};

/** `ClaudeMetadataIdentities`: session/parent/agent from `metadata.user_id` (JSON object or legacy suffix). */
export const claudeMetadataIdentities = (body: Json | undefined): ClaudeIdentities => {
  const none = { sessionId: "", parentSessionId: "", agentId: "" };
  const { root, nested } = requestRoot(body);

  if (root === undefined) return none;
  let userId = stringOf(get(root, "metadata.user_id")).trim();

  if (userId === "" && nested !== undefined)
    userId = stringOf(get(nested, "metadata.user_id")).trim();

  if (userId === "") return none;

  if (userId.startsWith("{")) {
    let parsed: Json;

    try {
      // SAFETY: JSON.parse always returns a JSON value, so naming it Json only records that.
      parsed = JSON.parse(userId) as Json;
    } catch {
      return none;
    }

    const pick = (...keys: string[]): string => {
      for (const key of keys) {
        const value = normalizeExplicitId(stringOf(get(parsed, key)));

        if (value !== "") return value;
      }

      return "";
    };

    return {
      sessionId: pick("session_id"),
      parentSessionId: pick("parent_session_id", "parent_agent_id", "parent_id"),
      agentId: pick("agent_id", "subagent_id"),
    };
  }

  const match = legacyClaudeSession.exec(userId);

  if (match === null) return none;

  const field = (...keys: string[]): string => {
    for (const key of keys) {
      const value = normalizeExplicitId(stringOf(get(root, key)));

      if (value !== "") return value;
    }

    return "";
  };

  return {
    sessionId: normalizeExplicitId(match[1]),
    parentSessionId: field(
      "metadata.parent_agent_id",
      "metadata.parent_session_id",
      "metadata.parent_id",
    ),
    agentId: field("metadata.agent_id", "metadata.subagent_id"),
  };
};

const PARENT_PATHS = [
  "parent_session_id",
  "parentSessionId",
  "parentSessionID",
  "parent_thread_id",
  "parentThreadId",
  "parentThreadID",
  "forked_from_thread_id",
  "forked_from_id",
  "parent_conversation_id",
  "parentConversationId",
  "parentConversationID",
  "parent_id",
  "parentId",
  "parentID",
  "parent_task_id",
  "parentTaskId",
  "parentTaskID",
  "parent_action_id",
  "parentActionId",
  "parentActionID",
  "parent_session",
  "parentSession",
  "parent_subagent_id",
  "parentSubagentId",
  "forkSource.sessionId",
  "fork_source.session_id",
  "previousSessionId",
  "previous_session_id",
  "metadata.parent_session_id",
  "metadata.parentSessionId",
  "metadata.parentSessionID",
  "metadata.parent_thread_id",
  "metadata.parentThreadId",
  "metadata.forked_from_thread_id",
  "metadata.forked_from_id",
  "metadata.parent_id",
  "metadata.parentId",
  "metadata.parentID",
  "metadata.parent_task_id",
  "metadata.parentTaskId",
  "metadata.parentTaskID",
  "metadata.parent_action_id",
  "metadata.parentActionId",
  "metadata.parent_subagent_id",
  "metadata.parentSubagentId",
  "metadata.parent_session",
  "metadata.parentSession",
  "metadata.parent_agent_id",
  "metadata.parentAgentId",
  "metadata.forkSource.sessionId",
  "metadata.previousSessionId",
  "extra_body.parent_session_id",
  "extra_body.parentSessionId",
  "extra_body.parentSessionID",
  "extra_body.parent_thread_id",
  "extra_body.parentThreadId",
  "extra_body.forked_from_thread_id",
  "extra_body.forked_from_id",
  "extra_body.parent_id",
  "extra_body.parentId",
  "extra_body.parentID",
  "extra_body.parent_task_id",
  "extra_body.parentTaskId",
  "extra_body.parent_action_id",
  "extra_body.parentActionId",
  "extra_body.parent_subagent_id",
  "extra_body.parentSubagentId",
  "extra_body.parent_session",
  "extra_body.parentSession",
] as const;

const FORK_PATHS = [
  "forked_from_thread_id",
  "forked_from_id",
  "forkSource.sessionId",
  "fork_source.session_id",
  "previousSessionId",
  "previous_session_id",
  "metadata.forked_from_thread_id",
  "metadata.forked_from_id",
  "metadata.forkSource.sessionId",
  "metadata.previousSessionId",
  "extra_body.forked_from_thread_id",
  "extra_body.forked_from_id",
  "extra_body.forkSource.sessionId",
  "extra_body.previousSessionId",
] as const;

const SESSION_PATHS = [
  "session_id",
  "sessionId",
  "sessionID",
  "child_session_id",
  "childSessionId",
  "metadata.session_id",
  "metadata.sessionId",
  "metadata.sessionID",
  "metadata.child_session_id",
  "extra_body.session_id",
  "extra_body.sessionId",
  "extra_body.sessionID",
] as const;

const TASK_PATHS = [
  "task_id",
  "taskId",
  "taskID",
  "action_id",
  "actionId",
  "actionID",
  "metadata.task_id",
  "metadata.taskId",
  "metadata.taskID",
  "metadata.action_id",
  "metadata.actionId",
  "metadata.actionID",
  "extra_body.task_id",
  "extra_body.taskId",
  "extra_body.taskID",
] as const;

const CONVERSATION_PATHS = [
  "conversation_id",
  "conversationId",
  "chat_id",
  "chatId",
  "metadata.conversation_id",
  "extra_body.conversation_id",
] as const;

type Draft = {
  sessionId: string;
  parentSessionId: string;
  agentName: string;
  clientType: string;
  isFork: boolean;
  isSubagent: boolean;
};

const finish = (draft: Draft): SessionInfo | undefined => {
  if (draft.sessionId === "") return undefined;
  const parent = draft.parentSessionId === draft.sessionId ? "" : draft.parentSessionId;

  return {
    sessionId: draft.sessionId,
    ...(parent === "" ? {} : { parentSessionId: parent }),
    agentName: draft.agentName === "" ? "main" : draft.agentName,
    clientType: draft.clientType === "" ? "generic" : draft.clientType,
    isFork: draft.isFork,
    isSubagent: draft.isSubagent,
  };
};

const base = (clientType: string): Draft => ({
  sessionId: "",
  parentSessionId: "",
  agentName: "",
  clientType,
  isFork: false,
  isSubagent: false,
});

/**
 * `ExtractSessionInfo` (explicit identities only). Priority: Claude Code headers, Claude `metadata.user_id`,
 * Codex/OpenAI session headers, Antigravity CLI, generic session/task/conversation/thread headers, then body fields.
 */
export const extractSessionInfo = (
  headers: Headers,
  body: Json | undefined,
): SessionInfo | undefined => {
  const { root, nested } = requestRoot(body);

  const header = (...names: string[]): string => {
    for (const name of names) {
      const value = normalizeExplicitId(headers.get(name) ?? undefined);

      if (value !== "") return value;
    }

    return "";
  };

  /** First non-empty candidate of `paths` in the body, falling back to the nested `request` object. */
  const field = (paths: readonly string[], source: Json | undefined = root): string => {
    if (source === undefined) return "";

    for (const path of paths) {
      const value = normalizeExplicitId(stringOf(get(source, path)));

      if (value !== "") return value;

      if (nested !== undefined && source === root) {
        const inner = normalizeExplicitId(stringOf(get(nested, path)));

        if (inner !== "") return inner;
      }
    }

    return "";
  };

  const parentCandidate = field(PARENT_PATHS) || claudeMetadataIdentities(body).parentSessionId;
  const agentFromBody = (): string => field(["metadata.agent_id", "metadata.subagent_id"]);

  const parentAgentFromBody = (): string =>
    field(["metadata.parent_agent_id", "metadata.parentAgentId"]);

  // 1. Claude Code headers.
  const claudeSid = header("X-Claude-Code-Session-Id");

  if (claudeSid !== "") {
    const info = base("claude");

    const agentId =
      header("X-Claude-Code-Agent-Id") || agentFromBody() || claudeMetadataIdentities(body).agentId;

    const parentAgentId = header("X-Claude-Code-Parent-Agent-Id") || parentAgentFromBody();

    if (agentId !== "" && agentId !== "main") {
      info.agentName = agentId;
      info.parentSessionId = `claude:${claudeSid}`;

      if (parentAgentId !== "" && parentAgentId !== "main" && parentAgentId !== agentId) {
        info.parentSessionId = `claude:${claudeSid}:agent:${parentAgentId}`;
      } else if (parentCandidate !== "" && parentCandidate !== claudeSid) {
        info.parentSessionId = `claude:${parentCandidate}`;
      }

      info.sessionId = `claude:${claudeSid}:agent:${agentId}`;
    } else {
      info.agentName = "main";
      info.sessionId = `claude:${claudeSid}`;

      if (parentCandidate !== "" && parentCandidate !== claudeSid) {
        info.parentSessionId = `claude:${parentCandidate}`;
        info.agentName = "subagent";
      }
    }

    return finish(info);
  }

  // 2. Claude Code metadata.user_id outranks the generic headers.
  const claude = claudeMetadataIdentities(body);

  if (claude.sessionId !== "") {
    const info = base("claude");
    const agentId = claude.agentId || header("X-Claude-Code-Agent-Id") || agentFromBody();
    const parentAgentId = header("X-Claude-Code-Parent-Agent-Id") || parentAgentFromBody();
    const sid = claude.sessionId;

    if (agentId !== "" && agentId !== "main") {
      info.sessionId = `claude:${sid}:agent:${agentId}`;
      info.parentSessionId = `claude:${sid}`;

      if (parentAgentId !== "" && parentAgentId !== "main" && parentAgentId !== agentId) {
        info.parentSessionId = `claude:${sid}:agent:${parentAgentId}`;
      } else if (claude.parentSessionId !== "" && claude.parentSessionId !== sid) {
        info.parentSessionId = `claude:${claude.parentSessionId}`;
      } else if (parentCandidate !== "" && parentCandidate !== sid) {
        info.parentSessionId = `claude:${parentCandidate}`;
      }

      info.agentName = agentId;
    } else {
      info.sessionId = `claude:${sid}`;

      if (claude.parentSessionId !== "" && claude.parentSessionId !== sid) {
        info.parentSessionId = `claude:${claude.parentSessionId}`;
        info.agentName = "subagent";
      } else if (parentCandidate !== "" && parentCandidate !== sid) {
        info.parentSessionId = `claude:${parentCandidate}`;
        info.agentName = "subagent";
      } else {
        info.agentName = "main";
      }
    }

    return finish(info);
  }

  // 3. OpenAI / Codex CLI headers.
  let sid = header("Session-Id", "Session_id");
  let tid = header("Thread-Id", "Thread_id");
  let turnMeta: Json | undefined;
  const rawTurnMeta = (headers.get("X-Codex-Turn-Metadata") ?? "").trim();

  if (rawTurnMeta !== "") {
    try {
      // SAFETY: JSON.parse always returns a JSON value, so naming it Json only records that.
      turnMeta = JSON.parse(rawTurnMeta) as Json;
    } catch {
      turnMeta = undefined;
    }
  }

  const turnField = (key: string): string =>
    turnMeta === undefined ? "" : normalizeExplicitId(stringOf(get(turnMeta, key)));

  if (sid === "") sid = turnField("session_id");

  if (tid === "") tid = turnField("thread_id");

  if (tid === "" && sid !== "") tid = field(["thread_id", "threadId", "metadata.thread_id"]);

  if (sid !== "" || tid !== "") {
    const info = base("codex");

    const parentThread =
      header("x-codex-parent-thread-id", "X-Codex-Parent-Thread-Id") ||
      turnField("parent_thread_id");

    const forkedFrom =
      turnField("forked_from_thread_id") ||
      turnField("forked_from_id") ||
      field([
        "forked_from_thread_id",
        "forked_from_id",
        "metadata.forked_from_thread_id",
        "metadata.forked_from_id",
        "extra_body.forked_from_thread_id",
        "extra_body.forked_from_id",
      ]);

    let agentName = "";

    if (turnMeta !== undefined) {
      const raw = stringOf(get(turnMeta, "agent_name"))
        .replace(/^\/root\//, "")
        .replace(/^\//, "")
        .trim();

      const cleaned = normalizeExplicitId(raw);

      if (cleaned !== "" && cleaned !== "root" && cleaned !== "main") agentName = cleaned;
    }

    const subagentHeader = header("X-Openai-Subagent");

    const subagentSignal =
      (subagentHeader !== "" &&
        subagentHeader.toLowerCase() !== "false" &&
        subagentHeader !== "0") ||
      (turnMeta !== undefined && stringOf(get(turnMeta, "subagent_kind")) === "thread_spawn");

    if (forkedFrom !== "") {
      let forkSession = tid === "" ? sid : tid;

      if (forkSession === forkedFrom && sid !== "" && sid !== forkedFrom) forkSession = sid;
      info.sessionId = `codex:${forkSession}`;
      info.parentSessionId = `codex:${forkedFrom}`;
      info.agentName = "main";
      info.isFork = true;

      return finish(info);
    }

    if (
      subagentSignal ||
      (tid !== "" && sid !== "" && tid !== sid) ||
      (parentThread !== "" && parentThread !== tid && parentThread !== sid)
    ) {
      const child = tid === "" ? sid : tid;
      const parent = parentThread === "" ? sid : parentThread;

      if (agentName !== "" && sid !== "") {
        info.sessionId = `codex:${sid}:agent:${agentName}`;
        info.agentName = agentName;

        if (parent !== "") info.parentSessionId = `codex:${parent}`;
        else if (parentCandidate !== "" && parentCandidate !== sid)
          info.parentSessionId = `codex:${parentCandidate}`;
      } else {
        info.sessionId = `codex:${child}`;
        info.agentName = agentName === "" ? "subagent" : agentName;

        if (parent !== "" && parent !== child) info.parentSessionId = `codex:${parent}`;
        else if (parentCandidate !== "" && parentCandidate !== child)
          info.parentSessionId = `codex:${parentCandidate}`;
      }

      info.isSubagent = true;

      return finish(info);
    }

    const session = sid === "" ? tid : sid;
    info.sessionId = `codex:${session}`;

    if (parentThread !== "" && parentThread !== session) {
      info.parentSessionId = `codex:${parentThread}`;
      info.agentName = "subagent";
      info.isSubagent = true;
    } else if (parentCandidate !== "" && parentCandidate !== session) {
      info.parentSessionId = `codex:${parentCandidate}`;
      info.agentName = "subagent";
      info.isSubagent = true;
    } else {
      info.agentName = "main";
    }

    return finish(info);
  }

  /** Header-keyed sessions: `prefix:<id>` with a parent from `parentHeaders` or the body. */
  /**
   * `extractSubagentID`: the first concrete (non-empty, not `main`) subagent id, body before headers before the nested
   * `request` object.
   */
  const subagentId = (): string => {
    const paths = ["metadata.agent_id", "metadata.subagent_id"];

    for (const path of paths) {
      const value = root === undefined ? "" : normalizeExplicitId(stringOf(get(root, path)));

      if (value !== "" && value !== "main") return value;
    }

    for (const name of ["X-Claude-Code-Agent-Id", "X-Agent-Id"]) {
      const value = header(name);

      if (value !== "" && value !== "main") return value;
    }

    for (const path of paths) {
      const value = nested === undefined ? "" : normalizeExplicitId(stringOf(get(nested, path)));

      if (value !== "" && value !== "main") return value;
    }

    return "";
  };

  /**
   * `extractHeaderParentAgentID`: the concrete parent agent id, and the first parent agent id the body named (`main`
   * included), which is not a parent session.
   */
  const headerParentAgent = () => {
    const paths = ["metadata.parent_agent_id", "metadata.parentAgentId"];
    let fromBody = "";

    const scan = (source: Json | undefined): string => {
      if (source === undefined) return "";

      for (const path of paths) {
        const value = normalizeExplicitId(stringOf(get(source, path)));

        if (value === "") continue;

        if (fromBody === "") fromBody = value;

        if (value !== "main") return value;
      }

      return "";
    };

    const own = scan(root);

    if (own !== "") return { id: own, fromBody: own };

    for (const name of ["X-Claude-Code-Parent-Agent-Id", "X-Parent-Agent-Id"]) {
      const value = header(name);

      if (value !== "" && value !== "main") return { id: value, fromBody };
    }

    const inner = scan(nested);

    return inner === "" ? { id: "", fromBody } : { id: inner, fromBody: inner };
  };

  /**
   * `applyHeaderSessionInfo` (CLIProxyAPI f9ac9ffc): a header session. An explicit parent header makes it a subagent;
   * a concrete agent id gives the agent a session of its own under the header session, so subagents of one session
   * keep distinct identities.
   */
  const headerSession = (
    clientType: string,
    prefix: string,
    id: string,
    parentHeaders: readonly string[],
    mainAgent = "main",
  ): SessionInfo | undefined => {
    const info = base(clientType);
    const sid = encodeSessionSegment(id);
    info.sessionId = `${prefix}:${sid}`;
    const parent = header(...parentHeaders);
    const agent = subagentId();

    if (parent !== "" && parent !== id) {
      info.parentSessionId = `${prefix}:${encodeSessionSegment(parent)}`;
      info.isSubagent = true;
      info.agentName = agent === "" ? "subagent" : agent;

      return finish(info);
    }

    if (agent !== "") {
      info.sessionId = `${prefix}:${sid}:agent:${encodeSessionSegment(agent)}`;
      info.parentSessionId = `${prefix}:${sid}`;
      const parentAgent = headerParentAgent();

      if (parentAgent.id !== "" && parentAgent.id !== agent) {
        info.parentSessionId = `${prefix}:${sid}:agent:${encodeSessionSegment(parentAgent.id)}`;
      } else if (
        parentCandidate !== "" &&
        parentCandidate !== id &&
        parentCandidate !== parentAgent.fromBody
      ) {
        info.parentSessionId = `${prefix}:${encodeSessionSegment(parentCandidate)}`;
      }

      info.agentName = agent;
      info.isSubagent = true;

      return finish(info);
    }

    if (parentCandidate !== "" && parentCandidate !== id) {
      info.parentSessionId = `${prefix}:${encodeSessionSegment(parentCandidate)}`;
      info.agentName = "subagent";
    } else {
      info.agentName = mainAgent;
    }

    return finish(info);
  };

  const PARENT_ID = ["X-Parent-ID", "X-Parent-Id"];
  const PARENT_SESSION = ["X-Parent-Session-ID", "X-Parent-Session-Id", ...PARENT_ID];

  // 4-5. Antigravity CLI and generic headers.
  const agy = header("X-Http-Session-Id");

  if (agy !== "") return headerSession("agy", "agy", agy, PARENT_SESSION);
  const xSession = header("X-Session-ID");

  if (xSession !== "") return headerSession("generic", "header", xSession, PARENT_SESSION);
  const affinity = header("X-Session-Affinity", "X-Opencode-Session");

  if (affinity !== "") {
    return headerSession("opencode", "affinity", affinity, [
      "X-Parent-Session-Affinity",
      "X-Parent-Session-ID",
      ...PARENT_ID,
    ]);
  }

  const slot = header("X-Slot-Session-Id");

  if (slot !== "")
    return headerSession(
      "pi",
      "slot",
      slot,
      ["X-Parent-Slot-Session-Id", ...PARENT_SESSION],
      "slot",
    );
  const task = header("X-Task-ID", "X-Task-Id", "X-Task_ID");

  if (task !== "") {
    return headerSession("task", "task", task, [
      "X-Parent-Task-ID",
      "X-Parent-Task-Id",
      ...PARENT_SESSION,
    ]);
  }

  const conversation = header("X-Conversation-Id");

  if (conversation !== "") {
    return headerSession("conv", "conv", conversation, ["X-Parent-Conversation-Id", "X-Parent-ID"]);
  }

  const thread = header("X-Thread-Id");

  if (thread !== "")
    return headerSession("openai-thread", "thread", thread, ["X-Parent-Thread-Id", "X-Parent-ID"]);
  const clientRequest = header("X-Client-Request-Id");

  if (clientRequest !== "") {
    return headerSession("generic", "clientreq", clientRequest, [
      "X-Parent-Session-ID",
      ...PARENT_ID,
    ]);
  }

  // 6. Payload inspection.
  if (root === undefined) return undefined;
  const bodyFork = field(FORK_PATHS) !== "";
  const cacheId = field(["cachedContent", "cached_content"]);

  if (cacheId !== "") {
    const info = base("gemini");
    info.sessionId = `geminicache:${cacheId}`;

    if (parentCandidate !== "" && parentCandidate !== cacheId) {
      info.parentSessionId = `geminicache:${parentCandidate}`;
      info.agentName = "subagent";
    } else {
      info.agentName = "main";
    }

    return finish(info);
  }

  const threadId = field(["thread_id", "threadId", "metadata.thread_id"]);

  if (threadId !== "") {
    const info = base("openai-thread");
    info.sessionId = `thread:${encodeSessionSegment(threadId)}`;

    if (parentCandidate !== "" && parentCandidate !== threadId) {
      info.parentSessionId = `thread:${encodeSessionSegment(parentCandidate)}`;

      if (bodyFork) {
        info.isFork = true;
        info.agentName = "main";
      } else {
        info.agentName = "subagent";
        info.isSubagent = true;
      }
    } else {
      info.agentName = "main";
    }

    return finish(info);
  }

  const bodyAgent = subagentId();

  const bodySession = field(SESSION_PATHS);

  if (bodySession !== "") {
    const info = base("generic");

    const sid = encodeSessionSegment(bodySession);

    if (bodyAgent !== "") {
      info.sessionId = `session:${sid}:agent:${encodeSessionSegment(bodyAgent)}`;
      info.parentSessionId = `session:${sid}`;

      if (parentCandidate !== "" && parentCandidate !== bodySession)
        info.parentSessionId = `session:${encodeSessionSegment(parentCandidate)}`;
      info.agentName = bodyAgent;
    } else {
      info.sessionId = `session:${sid}`;

      if (parentCandidate !== "" && parentCandidate !== bodySession) {
        info.parentSessionId = `session:${encodeSessionSegment(parentCandidate)}`;

        if (bodyFork) {
          info.isFork = true;
          info.agentName = "main";
        } else {
          info.agentName = "subagent";
          info.isSubagent = true;
        }
      } else {
        info.agentName = "main";
      }
    }

    return finish(info);
  }

  const bodyTask = field(TASK_PATHS);

  if (bodyTask !== "") {
    const info = base("task");
    info.sessionId = `task:${encodeSessionSegment(bodyTask)}`;

    if (parentCandidate !== "" && parentCandidate !== bodyTask) {
      info.parentSessionId = `task:${encodeSessionSegment(parentCandidate)}`;

      if (bodyFork) {
        info.isFork = true;
        info.agentName = "main";
      } else {
        info.agentName = "subagent";
        info.isSubagent = true;
      }
    } else {
      info.agentName = "main";
    }

    return finish(info);
  }

  // Prompt cache key and conversation object.
  const conversationObject =
    get(root, "conversation") ?? (nested === undefined ? undefined : get(nested, "conversation"));

  let conversationRaw = "";

  if (typeof conversationObject === "string") {
    conversationRaw = normalizeExplicitId(conversationObject);
  } else if (conversationObject !== undefined) {
    conversationRaw = normalizeExplicitId(stringOf(get(conversationObject, "id")));
  }

  const conversationId =
    conversationRaw === "" ? "" : `conv:${encodeSessionSegment(conversationRaw)}`;

  const promptCacheKey =
    normalizeExplicitId(stringOf(get(root, "prompt_cache_key"))) ||
    normalizeExplicitId(stringOf(get(root, "promptCacheKey"))) ||
    (nested === undefined
      ? ""
      : normalizeExplicitId(stringOf(get(nested, "prompt_cache_key"))) ||
        normalizeExplicitId(stringOf(get(nested, "promptCacheKey"))));

  if (promptCacheKey !== "") {
    const info = base("generic");
    info.sessionId = `pck:${promptCacheKey}`;

    if (parentCandidate !== "" && parentCandidate !== promptCacheKey) {
      info.parentSessionId = `pck:${parentCandidate}`;
      info.agentName = "subagent";
    } else {
      info.agentName = "main";
    }

    return finish(info);
  }

  if (conversationId !== "") {
    const info = base("conv");
    info.sessionId = conversationId;

    if (parentCandidate !== "" && parentCandidate !== conversationRaw) {
      info.parentSessionId = `conv:${encodeSessionSegment(parentCandidate)}`;
      info.agentName = "subagent";
    } else {
      info.agentName = "main";
    }

    return finish(info);
  }

  const userId = field(["metadata.user_id"]);

  if (userId !== "") {
    const info = base("generic");
    info.sessionId = `user:${userId}`;
    info.agentName = "main";

    return finish(info);
  }

  const legacyConversation = field(CONVERSATION_PATHS);

  if (legacyConversation !== "") {
    const info = base("conv");
    info.sessionId = `conv:${encodeSessionSegment(legacyConversation)}`;

    if (parentCandidate !== "" && parentCandidate !== legacyConversation) {
      info.parentSessionId = `conv:${encodeSessionSegment(parentCandidate)}`;
      info.agentName = "subagent";
    } else {
      info.agentName = "main";
    }

    return finish(info);
  }

  return undefined;
};
