/**
 * Interactions provider -> Claude Messages client (response, stream and non-stream).
 *
 * Go source: internal/translator/interactions/claude/interactions_claude_response.go
 * (ConvertInteractionsResponseToClaude, ConvertInteractionsResponseToClaudeNonStream).
 */
import { asInt, get, type Json, type JsonObject, set, tryParseJson } from "@commissary/json";
import { sseEventLines } from "../../common/bytes.ts";
import { eachValue, exists, isObj, str } from "../../common/gjson.ts";
import {
  firstExistingPath,
  firstNonBlankString,
  interactionsUsage,
} from "../../gemini/interactions/common.ts";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";

/** Go `interactionsToClaudeStreamState`. */
interface State {
  id: string;
  model: string;
  started: boolean;
  activeBlock: boolean;
  activeBlockType: string;
  blockIndex: number;
  sawToolCall: boolean;
  completed: boolean;
  stopped: boolean;
  done: boolean;
  stepTypes: Map<number, string>;
  toolNames: Map<number, string>;
  toolIds: Map<number, string>;
  toolSignatures: Map<number, string>;
}

const newState = (model: string): State => ({
  id: "",
  model,
  started: false,
  activeBlock: false,
  activeBlockType: "",
  blockIndex: 0,
  sawToolCall: false,
  completed: false,
  stopped: false,
  done: false,
  stepTypes: new Map(),
  toolNames: new Map(),
  toolIds: new Map(),
  toolSignatures: new Map(),
});

const firstNonEmpty = firstNonBlankString;

/** `fmt.Sprintf("msg_%d", time.Now().UnixNano())`. */
const newMessageId = (): string => `msg_${BigInt(Date.now()) * 1_000_000n}`;

/** `AppendSSEEventBytes(nil, event, payload, 3)`. */
const event = (name: string, payload: Json | string): string =>
  sseEventLines(name, typeof payload === "string" ? payload : JSON.stringify(payload), 3);

/** `ConvertInteractionsResponseToClaude`. */
export const convertInteractionsResponseToClaude = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  context.state.value ??= newState(context.model);
  // SAFETY: this translator is the only writer of `state.value` and initialises it to a State before this read.
  const st = context.state.value as State;
  st.model = firstNonEmpty(st.model, context.model);

  return convertEvent(context.model, line, st);
};

/** `ConvertInteractionsResponseToClaudeNonStream`. */
export const convertInteractionsResponseToClaudeNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = tryParseJson(body);
  const nested = get(root, "interaction");
  const interaction = exists(nested) ? nested : root;

  const out: JsonObject = {
    id: firstNonEmpty(str(get(interaction, "id")), str(get(root, "id")), newMessageId()),
    type: "message",
    role: "assistant",
    model: firstNonEmpty(str(get(interaction, "model")), context.model),
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  const stepsNode = get(interaction, "steps");
  const steps = exists(stepsNode) ? stepsNode : get(root, "steps");
  let sawToolCall = false;
  const blocks: JsonObject[] = [];

  for (const step of eachValue(steps)) {
    switch (str(get(step, "type"))) {
      case "thought":
        for (const text of contentTexts(get(step, "content"))) {
          const block: JsonObject = { type: "thinking", thinking: text };
          const signature = stepSignature(step);

          if (signature !== "") block.signature = signature;
          blocks.push(block);
        }

        break;
      case "function_call": {
        sawToolCall = true;

        const block: JsonObject = {
          type: "tool_use",
          id: toolId(step),
          name: str(get(step, "name")),
          input: {},
        };

        const signature = stepSignature(step);

        if (signature !== "") block.signature = signature;
        const args = firstExistingPath(step, ["arguments", "args"]);

        if (isObj(args)) block.input = args;
        blocks.push(block);
        break;
      }

      default:
        for (const text of contentTexts(get(step, "content"))) blocks.push({ type: "text", text });
    }
  }

  if (blocks.length > 0) out.content = blocks;

  if (sawToolCall) out.stop_reason = "tool_use";

  if (isMaxTokens(interaction, root)) out.stop_reason = "max_tokens";
  setUsage(out, "usage", interactionsUsage(root));

  return JSON.stringify(out);
};

/** `status == "incomplete"` or a length finish reason on the interaction or the root. */
const isMaxTokens = (interaction: Json | undefined, root: Json | undefined): boolean => {
  const status = firstNonEmpty(str(get(interaction, "status")), str(get(root, "status")));

  const finishReason = firstNonEmpty(
    str(get(interaction, "finish_reason")),
    str(get(root, "finish_reason")),
  );

  return status === "incomplete" || finishReason === "length" || finishReason === "max_tokens";
};

const convertEvent = (modelName: string, rawLine: string, st: State): string[] => {
  const payload = ssePayload(rawLine);

  if (payload === "") return [];

  if (payload.trim() === "[DONE]") return appendMessageStop([], st);
  const root = tryParseJson(payload);

  if (!exists(root)) return [];

  switch (str(get(root, "event_type"))) {
    case "interaction.created": {
      const interaction = get(root, "interaction");
      st.id = firstNonEmpty(str(get(interaction, "id")), st.id);
      st.model = firstNonEmpty(str(get(interaction, "model")), st.model, modelName);

      return appendMessageStart([], st);
    }

    case "step.start":
      return stepStart(root, st);
    case "step.delta":
      return stepDelta(root, st);
    case "step.stop":
      return appendContentBlockStop([], st);
    case "interaction.completed":
    case "finish":
      return appendMessageDelta([], root, st);
    case "response.failed":
    case "interaction.failed":
      return appendError([], root, st);
    case "done":
      return appendMessageStop([], st);
  }

  return [];
};

const stepStart = (root: Json, st: State): string[] => {
  let out = appendMessageStart([], st);
  out = appendContentBlockStop(out, st);
  const index = asInt(get(root, "index"));
  const step = get(root, "step");
  const stepType = str(get(step, "type"));
  st.stepTypes.set(index, stepType);

  switch (stepType) {
    case "function_call":
      st.sawToolCall = true;
      st.toolNames.set(index, str(get(step, "name")));
      st.toolIds.set(index, toolId(step));
      st.toolSignatures.set(index, stepSignature(step));
      out = appendToolBlockStart(out, index, st);

      return appendInlineArguments(out, firstExistingPath(step, ["arguments", "args"]), st);
    case "thought":
      return appendContentBlockStart(out, "thinking", st);
    default:
      return appendContentBlockStart(out, "text", st);
  }
};

/**
 * Arguments given inline on a function_call step.start become the tool block's first `input_json_delta`; empty ones
 * (blank, or `{}`) are skipped so later `arguments_delta` fragments still form valid JSON.
 */
const appendInlineArguments = (out: string[], args: Json | undefined, st: State): string[] => {
  if (args === undefined) return out;
  const arguments_ = typeof args === "string" ? args : JSON.stringify(args);

  if (arguments_.trim() === "" || (isObj(args) && Object.keys(args).length === 0)) return out;

  return appendContentDelta(out, "input_json_delta", "partial_json", arguments_, st);
};

const stepDelta = (root: Json, st: State): string[] => {
  const index = asInt(get(root, "index"));
  const delta = get(root, "delta");

  switch (str(get(delta, "type"))) {
    case "thought_summary": {
      let out = appendMessageStart([], st);
      out = ensureContentBlock(out, "thinking", st);
      const text = firstNonEmpty(str(get(delta, "content.text")), str(get(delta, "text")));

      return appendContentDelta(out, "thinking_delta", "thinking", text, st);
    }

    case "thought_signature":
      if (st.activeBlock && st.activeBlockType === "thinking") {
        return appendContentDelta(
          [],
          "signature_delta",
          "signature",
          str(get(delta, "signature")),
          st,
        );
      }

      return [];
    case "arguments_delta": {
      let out = appendMessageStart([], st);

      if (!st.activeBlock || st.activeBlockType !== "tool_use") {
        out = appendContentBlockStop(out, st);

        if ((st.toolNames.get(index) ?? "") === "")
          st.toolNames.set(index, str(get(root, "step.name")));

        if ((st.toolIds.get(index) ?? "") === "") st.toolIds.set(index, `toolu_${index}`);
        out = appendToolBlockStart(out, index, st);
      }

      return appendContentDelta(
        out,
        "input_json_delta",
        "partial_json",
        str(get(delta, "arguments")),
        st,
      );
    }

    default: {
      let out = appendMessageStart([], st);
      out = ensureContentBlock(out, "text", st);

      return appendContentDelta(out, "text_delta", "text", str(get(delta, "text")), st);
    }
  }
};

const appendMessageStart = (out: string[], st: State): string[] => {
  if (st.started) return out;

  const message: JsonObject = {
    id: firstNonEmpty(st.id, newMessageId()),
    type: "message",
    role: "assistant",
    content: [],
    model: st.model,
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  st.started = true;

  return [...out, event("message_start", { type: "message_start", message })];
};

const appendContentBlockStart = (out: string[], blockType: string, st: State): string[] => {
  if (st.activeBlock && st.activeBlockType === blockType) return out;
  out = appendContentBlockStop(out, st);

  const contentBlock: JsonObject =
    blockType === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" };

  st.activeBlock = true;
  st.activeBlockType = blockType;

  return [
    ...out,
    event("content_block_start", {
      type: "content_block_start",
      index: st.blockIndex,
      content_block: contentBlock,
    }),
  ];
};

const appendToolBlockStart = (out: string[], stepIndex: number, st: State): string[] => {
  out = appendContentBlockStop(out, st);

  const contentBlock: JsonObject = {
    type: "tool_use",
    id: firstNonEmpty(st.toolIds.get(stepIndex) ?? "", `toolu_${stepIndex}`),
    name: st.toolNames.get(stepIndex) ?? "",
    input: {},
  };

  const signature = st.toolSignatures.get(stepIndex) ?? "";

  if (signature !== "") contentBlock.signature = signature;
  st.activeBlock = true;
  st.activeBlockType = "tool_use";

  return [
    ...out,
    event("content_block_start", {
      type: "content_block_start",
      index: st.blockIndex,
      content_block: contentBlock,
    }),
  ];
};

const ensureContentBlock = (out: string[], blockType: string, st: State): string[] =>
  st.activeBlock && st.activeBlockType === blockType
    ? out
    : appendContentBlockStart(out, blockType, st);

const appendContentDelta = (
  out: string[],
  deltaType: string,
  field: string,
  value: string,
  st: State,
): string[] => {
  if (value === "" && deltaType !== "input_json_delta") return out;

  return [
    ...out,
    event("content_block_delta", {
      type: "content_block_delta",
      index: st.blockIndex,
      delta: { type: deltaType, [field]: value },
    }),
  ];
};

const appendContentBlockStop = (out: string[], st: State): string[] => {
  if (!st.activeBlock) return out;

  const next = [
    ...out,
    event("content_block_stop", { type: "content_block_stop", index: st.blockIndex }),
  ];

  st.activeBlock = false;
  st.activeBlockType = "";
  st.blockIndex++;

  return next;
};

const appendMessageDelta = (out: string[], root: Json | undefined, st: State): string[] => {
  if (st.completed) return out;
  out = appendMessageStart(out, st);
  out = appendContentBlockStop(out, st);
  const delta: JsonObject = { stop_reason: "end_turn", stop_sequence: null };

  const payload: JsonObject = {
    type: "message_delta",
    delta,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  if (st.sawToolCall) delta.stop_reason = "tool_use";

  if (isMaxTokens(get(root, "interaction"), root)) delta.stop_reason = "max_tokens";
  setUsage(payload, "usage", interactionsUsage(root));
  st.completed = true;

  return [...out, event("message_delta", payload)];
};

const appendMessageStop = (out: string[], st: State): string[] => {
  if (st.done) return out;
  out = appendContentBlockStop(out, st);

  if (!st.completed) out = appendMessageDelta(out, undefined, st);

  if (!st.stopped) {
    out = [...out, event("message_stop", `{"type":"message_stop"}`)];
    st.stopped = true;
  }

  st.done = true;

  return out;
};

const appendError = (out: string[], root: Json, st: State): string[] => {
  out = appendContentBlockStop(out, st);
  let errNode = get(root, "error");

  if (!exists(errNode)) errNode = get(root, "interaction.error");
  const message = str(get(errNode, "message"));
  const type = str(get(errNode, "type"));

  return [
    ...out,
    event("error", {
      type: "error",
      error: {
        type: type === "" ? "api_error" : type,
        message: message === "" ? "upstream error occurred" : message,
      },
    }),
  ];
};

/** `firstUsageInt`: the first existing path as an integer. */
const firstUsageInt = (usage: Json, paths: readonly string[]): number | undefined => {
  const value = firstExistingPath(usage, paths);

  return value === undefined ? undefined : asInt(value);
};

/** `setClaudeUsageFromInteractions`: Claude's `input_tokens` excludes cache reads and writes. */
const setUsage = (out: JsonObject, path: string, usage: Json | undefined): void => {
  if (!exists(usage)) return;
  const outputTokens = firstUsageInt(usage, ["output_tokens", "total_output_tokens"]);

  const cachedTokens = firstUsageInt(usage, [
    "cache_read_input_tokens",
    "cache_read_tokens",
    "cached_tokens",
    "total_cached_tokens",
  ]);

  const cacheWriteTokens = firstUsageInt(usage, [
    "cache_creation_input_tokens",
    "cache_creation_tokens",
    "cache_write_tokens",
  ]);

  let totalCache = 0;

  if (cachedTokens !== undefined && cachedTokens > 0) totalCache += cachedTokens;

  if (cacheWriteTokens !== undefined && cacheWriteTokens > 0) totalCache += cacheWriteTokens;

  let inputTokens: number | undefined;
  const explicit = get(usage, "input_tokens");

  if (exists(explicit)) inputTokens = asInt(explicit);
  else {
    const total = firstUsageInt(usage, ["total_input_tokens", "prompt_tokens"]);

    if (total !== undefined) inputTokens = total >= totalCache ? total - totalCache : 0;
  }

  if (inputTokens !== undefined) set(out, `${path}.input_tokens`, inputTokens);

  if (outputTokens !== undefined) set(out, `${path}.output_tokens`, outputTokens);

  if (cachedTokens !== undefined && cachedTokens > 0)
    set(out, `${path}.cache_read_input_tokens`, cachedTokens);

  if (cacheWriteTokens !== undefined && cacheWriteTokens > 0) {
    set(out, `${path}.cache_creation_input_tokens`, cacheWriteTokens);
  }
};

/** `interactionsSSEPayload`: the JSON of one SSE frame or line (`data:` lines joined, else the trimmed text). */
const ssePayload = (raw: string): string => {
  const trimmed = raw.trim();

  if (trimmed === "" || trimmed === "[DONE]") return trimmed;

  if (trimmed.startsWith("data:")) return trimmed.slice("data:".length).trim();

  const dataLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  return dataLines.length > 0 ? dataLines.join("\n") : trimmed;
};

/** `interactionsContentTexts`. */
const contentTexts = (content: Json | undefined): string[] => {
  if (!exists(content)) return [];

  if (typeof content === "string") return [content];
  const texts: string[] = [];

  for (const part of eachValue(content)) {
    const text = firstNonEmpty(str(get(part, "text")), str(get(part, "content.text")));

    if (text !== "") texts.push(text);
  }

  return texts;
};

const toolId = (root: Json | undefined): string =>
  firstNonEmpty(
    str(get(root, "call_id")),
    str(get(root, "id")),
    str(get(root, "tool_use_id")),
    "toolu_interactions",
  );

const stepSignature = (root: Json | undefined): string =>
  firstNonEmpty(
    str(get(root, "signature")),
    str(get(root, "thought_signature")),
    str(get(root, "thoughtSignature")),
    str(get(root, "extra_content.google.thought_signature")),
  );

export const interactionsClaudeResponse: ResponseTransform = {
  stream: convertInteractionsResponseToClaude,
  nonStream: convertInteractionsResponseToClaudeNonStream,
};
