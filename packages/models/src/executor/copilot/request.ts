/**
 * GitHub Copilot request shaping: the Copilot CLI's defaults, protocol fixes and inference headers. Pure functions over
 * parsed JSON; the bodies are mutated in place.
 *
 * Go source: internal/runtime/executor/helps/copilot.go (`ApplyCopilotThinking`'s defaults, `copilotHasOutputLimit`,
 * `NormalizeCopilotRequest`, `SetCopilotInferenceHeaders`, `flattenCopilotPlainTextContent`, `hasCopilotImage`;
 * f911b453 and 9abeef8c flatten assistant text history), helps/copilot_payload.go (`NormalizeCopilotSystemPrompt`),
 * helps/copilot_translation.go (the synthesized Claude user id is dropped), helps/copilot_turns.go
 * (`ParseCopilotTurnInput`: the initiator and the user-turn digest), internal/runtime/executor/copilot_executor_response.go
 * (`copilotResponseError`).
 */
import {
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { isClaudeCodeAttributionSystemText } from "@commissary/translation";
import { type Format, Formats } from "@commissary/translation/formats";
import { COPILOT_USER_AGENT } from "../../oauth/flows/copilot.ts";
import { ExecutionError } from "../errors.ts";
import { uuidV5 } from "../helps/uuid.ts";
import type { CopilotRoute } from "./routes.ts";

const has = (body: Json | undefined, path: string): boolean => get(body, path) !== undefined;

const text = (value: Json | undefined): string => (typeof value === "string" ? value : "");

const objects = (value: Json | undefined): JsonObject[] =>
  isJsonArray(value) ? value.filter(isJsonObject) : [];

/** `copilotHasOutputLimit`: the source asked for an output limit (the Claude translators also synthesize one). */
const hasOutputLimit = (source: Json, from: Format): boolean => {
  switch (from) {
    case Formats.Interactions: {
      const config = get(source, "generation_config") ?? get(source, "generationConfig");

      return has(config, "max_output_tokens") || has(config, "maxOutputTokens");
    }

    case Formats.Gemini:
      return has(source, "generationConfig.maxOutputTokens");
    case Formats.OpenAIResponse:
    case Formats.Codex:
      return has(source, "max_output_tokens");
    default:
      return has(source, "max_tokens") || has(source, "max_completion_tokens");
  }
};

export interface SeedInput {
  readonly route: CopilotRoute;
  readonly source: Json;
  readonly from: Format;
  /** The client's model carries a thinking suffix: its intent wins over every default. */
  readonly suffixed: boolean;
  /** Whether the upstream answer streams (the non-streaming output cap applies otherwise). */
  readonly upstreamStream: boolean;
}

/**
 * `ApplyCopilotThinking`'s defaults, before the thinking pipeline: the Messages `max_tokens` (the CLI's default, capped
 * by the model and, without streaming, by the non-streaming limit) and the CLI's default effort or budget where the
 * request names none. The thinking pipeline then validates them like client intent.
 */
export const seedCopilotDefaults = (body: JsonObject, input: SeedInput): void => {
  const { route } = input;

  if (
    route.format === Formats.Claude &&
    (!has(body, "max_tokens") || !hasOutputLimit(input.source, input.from))
  ) {
    let limit = route.defaultMaxTokens;
    const current = get(body, "max_tokens");

    if (limit <= 0 && typeof current === "number") limit = Math.trunc(current);

    if (limit <= 0) limit = route.maxCompletionTokens;

    if (limit <= 0) limit = 4096;

    if (route.maxCompletionTokens > 0) limit = Math.min(limit, route.maxCompletionTokens);

    if (!input.upstreamStream && route.nonStreamingOutput > 0)
      limit = Math.min(limit, route.nonStreamingOutput);
    body.max_tokens = limit;
  }

  if (input.suffixed) return;
  const effort = route.defaultEffort;

  switch (route.format) {
    case Formats.OpenAI:
      if (effort !== undefined && !has(body, "reasoning_effort")) body.reasoning_effort = effort;

      return;
    case Formats.Claude: {
      if (has(body, "output_config.effort")) return;
      const thinking = get(body, "thinking");
      const mode = text(get(thinking, "type"));

      if (
        effort !== undefined &&
        (mode === "adaptive" || thinking === undefined || (mode === "" && has(thinking, "display")))
      ) {
        body.thinking = { ...(isJsonObject(thinking) ? thinking : {}), type: "adaptive" };
        body.output_config = {
          ...(isJsonObject(body.output_config) ? body.output_config : {}),
          effort,
        };
      } else if (
        thinking === undefined &&
        route.defaultBudget > 0 &&
        typeof body.max_tokens === "number" &&
        body.max_tokens > route.defaultBudget
      ) {
        body.thinking = { type: "enabled", budget_tokens: route.defaultBudget };
      }

      return;
    }

    case Formats.OpenAIResponse:
      if (effort !== undefined && !has(body, "reasoning.effort")) {
        body.reasoning = {
          ...(isJsonObject(body.reasoning) ? body.reasoning : {}),
          effort,
        };
      }
  }
};

/**
 * `flattenCopilotPlainTextContent`: plain `{type:"text",text}` parts as one string (several only for assistant turns).
 * Annotated or multimodal content stays as it is.
 */
export const flattenPlainText = (
  content: Json | undefined,
  allowMultiple: boolean,
): string | undefined => {
  if (!isJsonArray(content) || content.length === 0) return undefined;

  if (!allowMultiple && content.length !== 1) return undefined;
  let out = "";

  for (const part of content) {
    if (
      !isJsonObject(part) ||
      part.type !== "text" ||
      typeof part.text !== "string" ||
      Object.keys(part).length !== 2
    ) {
      return undefined;
    }

    out += part.text;
  }

  return out;
};

/** The shared Claude translators synthesize a Claude Code user id; Copilot identifies the session by header. */
export const dropSynthesizedUserId = (body: JsonObject, source: Json, from: Format): void => {
  if (from !== Formats.OpenAI && from !== Formats.OpenAIResponse) return;

  if (has(source, "metadata.user_id") || has(source, "user")) return;
  const metadata = body.metadata;

  if (!isJsonObject(metadata)) return;
  delete metadata.user_id;

  if (Object.keys(metadata).length === 0) delete body.metadata;
};

/** `NormalizeCopilotRequest` for Chat Completions and Messages (Responses: {@link normalizeCopilotResponses}). */
export const normalizeCopilotRequest = (
  body: JsonObject,
  route: CopilotRoute,
  from: Format,
  source: Json,
  stream: boolean,
): void => {
  if (stream || route.format === Formats.Claude || has(source, "stream")) body.stream = stream;
  else delete body.stream;

  if (
    (route.defaultEffort !== undefined || route.defaultBudget > 0) &&
    !has(body, "temperature") &&
    !has(body, "top_p") &&
    !has(body, "top_k")
  ) {
    body.temperature = 1;
  }

  if (route.format === Formats.Claude) {
    const thinking = body.thinking;

    if (
      route.anthropicBetas.length > 0 &&
      isJsonObject(thinking) &&
      thinking.type === "adaptive" &&
      thinking.block_binding === undefined
    ) {
      thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
    }

    return;
  }

  if (route.disableSnippy && !has(body, "snippy")) body.snippy = { enabled: false };

  if (route.defaultToolChoice !== undefined && has(body, "tools.0") && !has(body, "tool_choice"))
    body.tool_choice = route.defaultToolChoice;

  if (!route.thinks) delete body.reasoning_effort;

  for (const message of objects(body.messages)) {
    if (message.role === "developer") message.role = "system";
    const role = text(message.role);

    // Copilot Chat can ignore assistant history sent as plain text blocks (9abeef8c, f911b453).
    if (
      role === "assistant" ||
      (from !== Formats.OpenAI && (role === "system" || role === "user"))
    ) {
      const flat = flattenPlainText(message.content, role === "assistant");

      if (flat !== undefined) message.content = flat;
    }

    if (from === Formats.Claude) {
      // A Claude tool_result has no Chat name field; native Chat envelopes stay as sent.
      if (role === "tool") delete message.name;

      if (role === "assistant" && has(message, "tool_calls.0") && message.content === "")
        message.content = null;
    }
  }

  if (stream && !has(body, "stream_options.include_usage")) {
    body.stream_options = {
      ...(isJsonObject(body.stream_options) ? body.stream_options : {}),
      include_usage: true,
    };
  }
};

/** Claude system text that is a prompt (Claude Code's attribution line is not). */
const isPromptText = (value: string): boolean =>
  value !== "" && !isClaudeCodeAttributionSystemText(value);

/**
 * `NormalizeCopilotSystemPrompt`: a leading system prompt the translators turned into `developer` input moves to
 * `instructions` or stays as input with the `system` role, as the model's CLI profile says. Explicit Responses
 * instructions and mid-turn messages stay where they are.
 */
const normalizeSystemPrompt = (
  body: JsonObject,
  route: CopilotRoute,
  from: Format,
  source: Json,
): void => {
  if (from !== Formats.OpenAI && from !== Formats.Claude) return;
  const explicit = get(source, "instructions");

  if (explicit !== undefined) body.instructions = explicit;
  else if (text(body.instructions) === "") delete body.instructions;

  if (route.systemPrompt === undefined) return;
  let count = 0;

  if (from === Formats.Claude) {
    const system = get(source, "system");

    if (typeof system === "string" && isPromptText(system)) count = 1;

    if (objects(system).some((part) => part.type === "text" && isPromptText(text(part.text))))
      count = 1;
  } else {
    for (const message of objects(get(source, "messages"))) {
      if (message.role !== "system") break;
      count++;
    }
  }

  const input = body.input;

  if (count === 0 || !isJsonArray(input)) return;
  const texts: string[] = [];

  for (const item of input.slice(0, count)) {
    if (!isJsonObject(item) || item.role !== "developer" || item.type !== "message") return;

    for (const part of isJsonArray(item.content) ? item.content : []) {
      if (!isJsonObject(part) || part.type !== "input_text") return;
      texts.push(text(part.text));
    }
  }

  if (input.length < count) return;

  if (route.systemPrompt === "instructions" && explicit === undefined && texts.length > 0) {
    body.instructions = texts.join("\n\n");
    input.splice(0, count);

    return;
  }

  for (const item of input.slice(0, count)) if (isJsonObject(item)) item.role = "system";
};

/** `NormalizeCopilotRequest` for Responses, with `NormalizeCopilotSystemPrompt` first. */
export const normalizeCopilotResponses = (
  body: JsonObject,
  route: CopilotRoute,
  from: Format,
  source: Json,
): void => {
  normalizeSystemPrompt(body, route, from, source);

  if (from === Formats.OpenAI && isJsonArray(body.input)) {
    // The CLI builds historical function item ids from call_id; the association id never changes.
    const items = objects(body.input);
    const ids = new Set(items.map((item) => text(item.id)));
    const counts = new Map<string, number>();

    for (const item of items) {
      if (item.type === "function_call") {
        const id = text(item.call_id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }

    for (const item of items) {
      const id = text(item.call_id);

      if (item.type !== "function_call" || id === "" || counts.get(id) !== 1) continue;

      if (item.id === undefined && !ids.has(`fc_${id}`)) item.id = `fc_${id}`;

      if (item.status === undefined) item.status = "completed";
    }
  }

  if (!has(body, "tools") && !has(body, "previous_response_id") && !has(body, "conversation"))
    body.tools = [];

  if (route.defaultVerbosity !== undefined && !has(body, "text.verbosity")) {
    body.text = {
      ...(isJsonObject(body.text) ? body.text : {}),
      verbosity: route.defaultVerbosity,
    };
  }

  for (const tool of objects(body.tools))
    if (tool.type === "function" && tool.strict === undefined) tool.strict = false;

  if (has(body, "tools.0") && !has(body, "parallel_tool_calls")) body.parallel_tool_calls = true;

  if (!has(body, "store")) body.store = false;

  if (!route.thinks) {
    delete body.reasoning;

    return;
  }

  const effort = text(get(body, "reasoning.effort"));

  if (effort === "" || effort === "none") return;
  const include = isJsonArray(body.include) ? body.include : [];

  if (!include.includes("reasoning.encrypted_content"))
    body.include = [...include, "reasoning.encrypted_content"];
};

// --- turns and headers ---------------------------------------------------------------------------------------------

/** The source transcript of a client format (`ParseCopilotTurnInput`'s path). */
const transcriptOf = (source: Json, from: Format): Json | undefined => {
  switch (from) {
    case Formats.Gemini:
      return get(source, "contents");
    case Formats.OpenAIResponse:
    case Formats.Codex:
    case Formats.Interactions:
      return get(source, "input");
    default:
      return get(source, "messages");
  }
};

export interface CopilotTurnInput {
  /** `user` for a real user turn, `agent` for a follow-up that only carries tool results. */
  readonly initiator: "user" | "agent";
  /** Digest of the user inputs in order (the turn that started the current exchange). */
  readonly history: string;
}

/** `ParseCopilotTurnInput`'s initiator and history digest, from the client transcript before translation. */
export const parseCopilotTurnInput = (source: Json, from: Format): CopilotTurnInput => {
  const transcript = transcriptOf(source, from);

  if (typeof transcript === "string") return { initiator: "user", history: transcript };
  let initiator: "user" | "agent" = "user";
  const history: string[] = [];

  for (const message of objects(transcript)) {
    let role = text(message.role);

    if (role === "system" || role === "developer") continue;
    let content = message.content;

    if (from === Formats.Gemini) {
      content = message.parts;

      if (role === "") role = "user";
    } else if (from === Formats.Interactions && role === "" && message.type !== "function_result") {
      role = "user";
    }

    initiator = "agent";

    if (role !== "user") continue;
    let result = false;
    let user = false;
    const parts = isJsonArray(content) ? content : [];

    for (const part of parts) {
      if (!isJsonObject(part)) {
        user = true;
        continue;
      }

      if (part.type === "tool_result") result = true;
      else if (part.functionResponse !== undefined || part.function_response !== undefined)
        result = true;
      else if (part.text !== undefined) user = user || text(part.text) !== "";
      else user = true;
    }

    if (result && !user) continue;
    initiator = "user";
    history.push(typeof content === "string" ? content : JSON.stringify(content ?? message));
  }

  return { initiator, history: JSON.stringify(history) };
};

/** Go `copilot.CLIEditor`. */
const COPILOT_EDITOR = "copilot/1.0.114";

/** `uuid.NameSpaceURL`, the namespace of Go's session scope. */
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

export interface CopilotTurnIds {
  readonly session: string;
  readonly interaction: string;
  readonly task: string;
}

/**
 * The CLI's session, interaction and task ids. Go links a tool-result follow-up to the turn that issued the calls with
 * in-memory turn links; here the ids are derived from the credential, the caller, the session and the user-turn digest,
 * so every request of one user turn (its tool follow-ups included) shares them without server state.
 */
export const copilotTurnIds = (input: {
  readonly credentialId: string;
  readonly callerScope: string;
  readonly sessionId: string | undefined;
  readonly history: string;
}): CopilotTurnIds => {
  const scope = uuidV5(
    NAMESPACE_URL,
    `${input.credentialId}\u0000${input.callerScope}\u0000${input.sessionId ?? ""}`,
  );

  const session = input.sessionId === undefined ? crypto.randomUUID() : scope;
  const turn = uuidV5(scope, input.history);

  return {
    session,
    interaction: uuidV5(turn, "interaction"),
    task: uuidV5(turn, "task"),
  };
};

/** `hasCopilotImage`. */
const hasImage = (content: Json | undefined): boolean =>
  objects(content).some((part) => {
    switch (part.type) {
      case "image":
      case "image_url":
      case "input_image":
        return true;
      case "tool_result":
        return hasImage(part.content);
      default:
        return false;
    }
  });

/** `SetCopilotInferenceHeaders`: the CLI's identity, the turn ids, vision and the Messages betas. */
export const copilotHeaders = (input: {
  readonly route: CopilotRoute;
  readonly body: Json;
  readonly initiator: "user" | "agent";
  readonly ids: CopilotTurnIds;
  readonly token: string;
}): Headers => {
  const { route, body } = input;

  const headers = new Headers({
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
    "user-agent": `${COPILOT_USER_AGENT} client/sdk`,
    "editor-version": COPILOT_EDITOR,
    "copilot-integration-id": "copilot-developer-cli",
    "x-github-api-version": "2026-08-01",
    "x-initiator": input.initiator,
    "x-interaction-type": `conversation-${input.initiator}`,
    "x-interaction-id": input.ids.interaction,
    "x-agent-task-id": input.ids.task,
    "x-client-session-id": input.ids.session,
  });

  if (get(body, "stream") === true) headers.set("x-stainless-helper-method", "stream");

  if (route.format !== Formats.Claude) {
    headers.set("accept", "application/json");
    headers.set("openai-intent", "conversation-agent");
  }

  const items = objects(get(body, route.format === Formats.OpenAIResponse ? "input" : "messages"));

  if (items.some((item) => hasImage(item.content) || hasImage(item.output)))
    headers.set("copilot-vision-request", "true");

  if (route.format === Formats.Claude) {
    headers.set("anthropic-version", "2023-06-01");
    const thinking = get(body, "thinking");

    if (
      get(thinking, "type") === "adaptive" &&
      isJsonObject(get(thinking, "block_binding")) &&
      route.anthropicBetas.length > 0
    ) {
      headers.set("anthropic-beta", route.anthropicBetas.join(","));
    }
  }

  return headers;
};

/** `copilotResponseError`: an answer or SSE frame that reports a failure (429 for a rate limit, else 502). */
export const copilotResponseError = (payload: string): ExecutionError | undefined => {
  const root = tryParseJson(payload);

  if (!isJsonObject(root)) return undefined;
  let failure = root.error;

  if (failure === undefined || failure === null) failure = get(root, "response.error");
  const failed = failure !== undefined && failure !== null;

  if (
    !failed &&
    root.type !== "error" &&
    root.type !== "response.failed" &&
    root.status !== "failed"
  ) {
    return undefined;
  }

  const code = text(get(failure, "code")) || text(root.code);

  if (code === "rate_limit_exceeded" || get(failure, "type") === "rate_limit_error")
    return new ExecutionError({ status: 429, message: "copilot: upstream rate limit" });

  return new ExecutionError({
    status: 502,
    message: "copilot: upstream reported a generation error",
  });
};

/**
 * `CopilotVisibleChatReasoning`: Copilot Chat names its visible reasoning `reasoning_text`; the translators read
 * `reasoning_content`. `node` is `message` for an answer, `delta` for a stream chunk.
 */
export const visibleChatReasoning = (payload: string, node: "message" | "delta"): string => {
  if (!payload.includes('"reasoning_text"')) return payload;
  const root = tryParseJson(payload);
  let changed = false;

  for (const choice of objects(get(root, "choices"))) {
    const target = choice[node];
    const reasoning = get(target, "reasoning_text");

    if (!isJsonObject(target) || typeof reasoning !== "string" || reasoning === "") continue;
    target.reasoning_content = reasoning;
    changed = true;
  }

  return changed && root !== undefined ? JSON.stringify(root) : payload;
};
