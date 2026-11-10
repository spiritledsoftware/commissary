/**
 * Claude Messages client -> Interactions provider (request).
 *
 * Go source: internal/translator/interactions/claude/interactions_claude_request.go
 * (ConvertClaudeRequestToInteractions, ConvertClaudeRequestToInteractionsWithCompat).
 */
import {
  asBool,
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import {
  alignClaudeToolResults,
  claudeMessageSystemReminderText,
} from "../../common/claude-messages.ts";
import { exists, isArr, isObj, str } from "../../common/gjson.ts";
import { UserTurnDrops } from "../../common/parts.ts";
import { firstNonBlankString } from "../../gemini/interactions/common.ts";

/** `ConvertClaudeRequestToInteractions`. */
export const convertClaudeRequestToInteractions = (
  modelName: string,
  input: Json,
  stream: boolean,
): Json => convert(modelName, input, stream, false);

/** `ConvertClaudeRequestToInteractionsWithCompat`: keeps empty assistant thinking blocks for compatibility endpoints. */
export const convertClaudeRequestToInteractionsWithCompat = (
  modelName: string,
  input: Json,
  stream: boolean,
): Json => convert(modelName, input, stream, true);

const lower = (value: Json | undefined): string => str(value).trim().toLowerCase();

const convert = (
  modelName: string,
  root: Json,
  stream: boolean,
  preserveEmptyThinkingBlocks: boolean,
): Json => {
  const out: JsonObject = {
    model: firstNonBlankString(modelName, str(get(root, "model"))),
    input: [],
  };

  const streamValue = get(root, "stream");

  if (exists(streamValue)) out.stream = asBool(streamValue);
  else if (stream) out.stream = true;
  copySystem(out, root);
  copyGenerationConfig(out, root);
  const drops = new UserTurnDrops();
  appendMessages(out, get(root, "messages"), preserveEmptyThinkingBlocks, drops);
  copyTools(out, root);
  const refusal = drops.err(out);

  if (refusal !== undefined) throw refusal;

  return out;
};

/** `claudeText`. */
const claudeText = (value: Json | undefined): string => {
  if (value === undefined) return "";

  if (typeof value === "string") return value;

  if (isObj(value)) {
    const text = get(value, "text");

    return exists(text) ? str(text) : "";
  }

  if (!isArr(value)) return "";
  const parts: string[] = [];

  for (const item of value) {
    const text = claudeText(item);

    if (text !== "") parts.push(text);
  }

  return parts.join("\n");
};

const copySystem = (out: JsonObject, root: Json): void => {
  const text = claudeText(get(root, "system"));

  if (text !== "") out.system_instruction = text;
};

const copyField = (out: JsonObject, root: Json, from: string, to: string): void => {
  const value = get(root, from);

  if (exists(value)) set(out, to, cloneJson(value));
};

const copyGenerationConfig = (out: JsonObject, root: Json): void => {
  copyField(out, root, "max_tokens", "generation_config.max_output_tokens");
  copyField(out, root, "temperature", "generation_config.temperature");
  copyField(out, root, "top_p", "generation_config.top_p");
  copyField(out, root, "stop_sequences", "generation_config.stop_sequences");
  copyThinking(out, root);
  copyToolChoice(out, get(root, "tool_choice"));
};

const copyThinking = (out: JsonObject, root: Json): void => {
  const thinking = get(root, "thinking");

  if (exists(thinking)) {
    switch (lower(get(thinking, "type"))) {
      case "disabled":
        set(out, "generation_config.thinking_level", "none");
        break;
      case "enabled": {
        const budget = get(thinking, "budget_tokens");

        if (exists(budget))
          set(out, "generation_config.thinking_config.thinking_budget", cloneJson(budget));
        else set(out, "generation_config.thinking_level", "high");
        break;
      }

      case "adaptive":
        set(out, "generation_config.thinking_level", "auto");
        break;
    }
  }

  const effort = get(root, "output_config.effort");

  if (typeof effort === "string")
    set(out, "generation_config.thinking_level", effort.trim().toLowerCase());
};

const copyToolChoice = (out: JsonObject, toolChoice: Json | undefined): void => {
  if (!exists(toolChoice)) return;

  const choose = (kind: string): void => {
    switch (kind) {
      case "auto":
        set(out, "generation_config.tool_choice", "auto");
        break;
      case "any":
      case "required":
        set(out, "generation_config.tool_choice", "required");
        break;
    }
  };

  if (typeof toolChoice === "string") {
    choose(toolChoice.trim().toLowerCase());
  } else if (isObj(toolChoice) || isArr(toolChoice)) {
    const kind = lower(get(toolChoice, "type"));

    if (kind === "tool") {
      const name = str(get(toolChoice, "name")).trim();

      if (name !== "") set(out, "generation_config.tool_choice", { type: "function", name });
    } else choose(kind);
  }
};

/** Mutable conversation state of `appendClaudeMessagesToInteractions`. */
interface Conversation {
  readonly items: Json[];
  pendingToolUseIds: string[];
  pendingSystemReminders: JsonObject[];
  readonly toolNamesById: Map<string, string>;
  readonly preserveEmptyThinkingBlocks: boolean;
  readonly drops: UserTurnDrops;
}

const flushPendingReminders = (conversation: Conversation): void => {
  conversation.items.push(...conversation.pendingSystemReminders);
  conversation.pendingSystemReminders = [];
};

const appendMessages = (
  out: JsonObject,
  messages: Json | undefined,
  preserveEmptyThinkingBlocks: boolean,
  drops: UserTurnDrops,
): void => {
  if (!isArr(messages)) return;

  const conversation: Conversation = {
    items: [],
    pendingToolUseIds: [],
    pendingSystemReminders: [],
    toolNamesById: new Map(),
    preserveEmptyThinkingBlocks,
    drops,
  };

  for (const message of messages) {
    const role = lower(get(message, "role"));
    let content = get(message, "content");

    if (role === "system") {
      const reminder = claudeMessageSystemReminderText(content);

      if (reminder !== undefined) {
        const step: JsonObject = {
          type: "user_input",
          content: [{ type: "text", text: reminder }],
        };

        if (conversation.pendingToolUseIds.length > 0)
          conversation.pendingSystemReminders.push(step);
        else conversation.items.push(step);
      }

      continue;
    }

    if (role === "user" && conversation.pendingToolUseIds.length > 0 && isArr(content)) {
      content = alignClaudeToolResults(content, conversation.pendingToolUseIds);
    }

    conversation.pendingToolUseIds = [];
    const sendable = appendMessage(conversation, role, content);

    if (role === "user") drops.endTurn(sendable);
    flushPendingReminders(conversation);
  }

  flushPendingReminders(conversation);

  if (conversation.items.length > 0) out.input = conversation.items;
};

/** `appendClaudeMessageToInteractions`: returns the number of parts the turn itself sends. */
const appendMessage = (
  conversation: Conversation,
  role: string,
  content: Json | undefined,
): number => {
  const { items, drops } = conversation;
  const defaultStepType = role === "assistant" ? "model_output" : "user_input";

  if (typeof content === "string") {
    flushPendingReminders(conversation);
    items.push({ type: defaultStepType, content: [{ type: "text", text: content }] });

    return 1;
  }

  if (!isArr(content)) return 0;
  // Counts only what this turn itself sends, not system reminders flushed beside it.
  // Whitespace-only text is forwarded but never keeps an emptied turn alive.
  let sendable = 0;
  let stepContent: Json[] = [];

  const flushContent = (): void => {
    if (stepContent.length === 0) return;
    items.push({ type: defaultStepType, content: stepContent });
    stepContent = [];
  };

  const flushReminders = (): void => {
    if (conversation.pendingSystemReminders.length === 0) return;
    flushContent();
    flushPendingReminders(conversation);
  };

  for (const part of content) {
    const partType = lower(get(part, "type"));

    switch (partType) {
      case "text": {
        const text = str(get(part, "text"));

        if (text === "") break;
        flushReminders();
        stepContent.push({ type: "text", text });

        if (text.trim() !== "") sendable++;
        break;
      }

      case "thinking": {
        flushContent();
        const text = str(get(part, "thinking"));

        if (text !== "" || conversation.preserveEmptyThinkingBlocks) {
          items.push({ type: "thought", content: [{ type: "text", text }] });
          sendable++;
        }

        break;
      }

      case "image":
      case "document":
      case "container_upload": {
        const media = mediaPart(part, partType);

        if (media !== undefined) {
          flushReminders();
          stepContent.push(media);
          sendable++;
        } else if (role === "user") drops.drop(partType);
        break;
      }

      case "tool_use": {
        flushContent();
        const id = str(get(part, "id"));

        if (id !== "") {
          conversation.pendingToolUseIds.push(id);
          const name = str(get(part, "name"));

          if (name !== "") conversation.toolNamesById.set(id, name);
        }

        items.push(toolUseStep(part));
        sendable++;
        break;
      }

      case "tool_result":
        flushContent();
        items.push(toolResultStep(part, conversation.toolNamesById));
        sendable++;
        break;
    }
  }

  flushContent();

  return sendable;
};

/** `claudeMediaPartToInteractions`: only inline base64 data can be forwarded. */
const mediaPart = (part: Json | undefined, partType: string): JsonObject | undefined => {
  const source = get(part, "source");
  let mimeType = str(get(source, "media_type"));
  let data = str(get(source, "data"));

  if (data === "") data = str(get(part, "data"));

  if (mimeType === "") mimeType = str(get(part, "mime_type"));

  if (mimeType === "" || data === "") return undefined;

  return { type: partType, mime_type: mimeType, data };
};

const toolUseStep = (part: Json | undefined): JsonObject => {
  const step: JsonObject = { type: "function_call", name: str(get(part, "name")), arguments: {} };
  const id = str(get(part, "id"));

  if (id !== "") step.id = id;
  const input = get(part, "input");

  if (isJsonObject(input)) step.arguments = cloneJson(input);

  return step;
};

/** Keys of a plain text block that carry no business data beyond the text itself. */
const PURE_TEXT_KEYS = new Set(["type", "text", "cache_control"]);

const toolResultItem = (item: Json): Json | undefined => {
  const itemType = str(get(item, "type"));

  switch (itemType) {
    case "text":
      if (!isJsonObject(item) || Object.keys(item).every((key) => PURE_TEXT_KEYS.has(key))) {
        return { type: "text", text: str(get(item, "text")) };
      }

      return cloneJson(item);
    case "image":
    case "document":
    case "container_upload":
      return mediaPart(item, itemType) ?? cloneJson(item);
    default:
      return cloneJson(item);
  }
};

const toolResultStep = (
  part: Json | undefined,
  toolNamesById: ReadonlyMap<string, string>,
): JsonObject => {
  const step: JsonObject = { type: "function_result", call_id: "", result: "" };
  const id = str(get(part, "tool_use_id"));

  if (id !== "") step.call_id = id;
  let name = str(get(part, "name"));

  if (name === "" && id !== "") name = toolNamesById.get(id) ?? "";

  if (name !== "") step.name = name;

  if (asBool(get(part, "is_error"))) step.is_error = true;
  const result = get(part, "content");

  if (exists(result)) {
    if (typeof result === "string") step.result = result;
    else if (isJsonArray(result)) {
      step.result = result.flatMap((item) => {
        const converted = toolResultItem(item);

        return converted === undefined ? [] : [converted];
      });
    } else step.result = cloneJson(result);
  }

  return step;
};

const copyTools = (out: JsonObject, root: Json): void => {
  const tools = get(root, "tools");

  if (!isArr(tools)) return;
  const items: JsonObject[] = [];

  for (const tool of tools) {
    const name = str(get(tool, "name")).trim();

    if (name === "") continue;
    const item: JsonObject = { type: "function", name, parameters: {} };
    const description = get(tool, "description");

    if (exists(description)) item.description = asString(description);
    const schema = get(tool, "input_schema");

    if (isJsonObject(schema)) item.parameters = cloneJson(schema);
    items.push(item);
  }

  if (items.length > 0) out.tools = items;
};
