/**
 * Claude Messages provider -> Interactions client (response).
 *
 * Go source: internal/translator/claude/interactions/interactions_claude_response.go.
 */
import { asInt, get, type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { exists, isObj, str } from "../../common/gjson.ts";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";

/** Go `claudeToInteractionsStreamState`. */
interface State {
  id: string;
  model: string;
  created: boolean;
  statusUpdated: boolean;
  completed: boolean;
  done: boolean;
  stopReason: string;
  usageRaw: JsonObject | undefined;
  stepIndex: number;
  activeStepIndex: number;
  activeStepType: string;
  activeStepOpen: boolean;
  currentStepByIndex: Map<number, string>;
  toolNames: Map<number, string>;
  toolIds: Map<number, string>;
  toolArgs: Map<number, string>;
}

const newState = (model: string): State => ({
  id: "",
  model,
  created: false,
  statusUpdated: false,
  completed: false,
  done: false,
  stopReason: "",
  usageRaw: undefined,
  stepIndex: 0,
  activeStepIndex: 0,
  activeStepType: "",
  activeStepOpen: false,
  currentStepByIndex: new Map(),
  toolNames: new Map(),
  toolIds: new Map(),
  toolArgs: new Map(),
});

const firstNonEmpty = (...values: string[]): string => values.find((value) => value !== "") ?? "";

/** `fmt.Sprintf("interaction_%d", time.Now().UnixNano())`. */
const newInteractionId = (): string => `interaction_${BigInt(Date.now()) * 1_000_000n}`;

/** `translatorcommon.SSEEventData`. */
const sseEventData = (event: string, payload: Json | string): string =>
  `event: ${event}\ndata: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;

/** `ConvertClaudeResponseToInteractions`. */
export const convertClaudeResponseToInteractions = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const modelName = context.model;
  context.state.value ??= newState(modelName);
  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  const st = context.state.value as State;
  st.model = firstNonEmpty(st.model, modelName);

  return convertEvent(modelName, line, st);
};

/** `ConvertClaudeResponseToInteractionsNonStream`. */
export const convertClaudeResponseToInteractionsNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = tryParseJson(body);

  if (exists(root) && exists(get(root, "content")))
    return JSON.stringify(convertMessage(context.model, root));

  return JSON.stringify(convertSSENonStream(context.model, body));
};

const interactionTemplate = (): JsonObject => ({
  id: "",
  object: "interaction",
  status: "completed",
  model: "",
  steps: [],
});

const convertMessage = (modelName: string, root: Json | undefined): JsonObject => {
  const out = interactionTemplate();
  out.id = firstNonEmpty(str(get(root, "id")), newInteractionId());
  out.model = firstNonEmpty(str(get(root, "model")), modelName);
  out.status = interactionsStatus(str(get(root, "stop_reason")));
  const steps: JsonObject[] = [];
  const content = get(root, "content");
  const blocks = Array.isArray(content) ? content : isObj(content) ? [content] : [];

  for (const part of blocks) {
    const step = blockToStep(part);

    if (step !== undefined) steps.push(step);
  }

  if (steps.length > 0) out.steps = steps;
  setUsage(out, "usage", get(root, "usage"));

  return out;
};

const convertSSENonStream = (modelName: string, body: string): JsonObject => {
  const out = interactionTemplate();
  out.id = newInteractionId();
  out.model = modelName;
  const st = newState(modelName);
  const steps: JsonObject[] = [];

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();

    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();

    if (payload === "[DONE]") continue;
    const root = tryParseJson(payload);

    switch (str(get(root, "type"))) {
      case "message_start": {
        const msg = get(root, "message");
        const id = str(get(msg, "id"));

        if (id !== "") out.id = id;
        const model = str(get(msg, "model"));

        if (model !== "") out.model = model;
        mergeUsage(st, get(msg, "usage"));
        break;
      }

      case "content_block_start":
        nonStreamBlockStart(root, st);
        break;
      case "content_block_delta":
        nonStreamBlockDelta(root, st);
        break;
      case "content_block_stop": {
        const step = nonStreamBlockStop(root, st);

        if (step !== undefined) steps.push(step);
        break;
      }

      case "message_delta":
        mergeUsage(st, get(root, "usage"));
        st.stopReason = firstNonEmpty(str(get(root, "delta.stop_reason")), st.stopReason);
        break;
    }
  }

  out.status = interactionsStatus(st.stopReason);

  if (steps.length > 0) out.steps = steps;
  setUsage(out, "usage", mergedUsage(st));

  return out;
};

const convertEvent = (modelName: string, line: string, st: State): string[] => {
  const trimmed = line.trim();
  let payload: string;

  if (trimmed === "[DONE]") payload = trimmed;
  else if (!trimmed.startsWith("data:")) return [];
  else payload = trimmed.slice(5).trim();

  if (payload === "") return [];

  if (payload === "[DONE]") return appendDone([], st);
  const root = tryParseJson(payload);

  switch (str(get(root, "type"))) {
    case "message_start": {
      const msg = get(root, "message");
      st.id = firstNonEmpty(str(get(msg, "id")), st.id, newInteractionId());
      st.model = firstNonEmpty(str(get(msg, "model")), st.model, modelName);
      mergeUsage(st, get(msg, "usage"));

      return appendCreated([], st, st.model);
    }

    case "content_block_start":
      return blockStart(modelName, root, st);
    case "content_block_delta":
      return blockDelta(modelName, root, st);
    case "content_block_stop": {
      const index = asInt(get(root, "index"));
      const out = appendStepStop([], st);
      st.currentStepByIndex.delete(index);
      st.toolNames.delete(index);
      st.toolIds.delete(index);
      st.toolArgs.delete(index);

      return out;
    }

    case "message_delta": {
      mergeUsage(st, get(root, "usage"));

      // A usage-only delta keeps the step open until the stop reason arrives.
      if (str(get(root, "delta.stop_reason")) === "") return [];
      const out = appendStepStop([], st);

      return appendCompleted(out, st, modelName, root);
    }

    case "message_stop":
      return st.completed ? [] : appendCompleted([], st, modelName, root);
    case "error": {
      const out = appendCreated([], st, modelName);

      return appendCompleted(out, st, modelName, root);
    }
  }

  return [];
};

const blockStart = (modelName: string, root: Json | undefined, st: State): string[] => {
  let out = appendCreated([], st, modelName);
  out = appendStepStop(out, st);
  const index = asInt(get(root, "index"));
  const block = get(root, "content_block");
  const stepType = blockStepType(str(get(block, "type")));
  st.currentStepByIndex.set(index, stepType);

  if (stepType === "function_call") {
    const name = str(get(block, "name"));

    if (name !== "") st.toolNames.set(index, name);
    const id = str(get(block, "id"));

    if (id !== "") st.toolIds.set(index, id);
    const input = get(block, "input");

    if (isObj(input) && JSON.stringify(input) !== "{}")
      st.toolArgs.set(index, JSON.stringify(input));
  }

  return appendStepStart(out, st, stepType, blockToStartStep(block, stepType));
};

const blockDelta = (modelName: string, root: Json | undefined, st: State): string[] => {
  const index = asInt(get(root, "index"));
  const delta = get(root, "delta");
  const stepType = st.currentStepByIndex.get(index) ?? "";

  if (stepType === "") {
    const derived = deltaStepType(str(get(delta, "type")));
    let out = appendCreated([], st, modelName);
    out = appendStepStop(out, st);
    out = appendStepStart(out, st, derived, { type: derived });
    st.currentStepByIndex.set(index, derived);

    return appendDelta(out, st, delta, index);
  }

  if (!st.activeStepOpen || st.activeStepIndex !== index) {
    let out = appendCreated([], st, modelName);
    out = appendStepStop(out, st);
    out = appendStepStart(out, st, stepType, knownIndexStep(stepType, index, st));

    return appendDelta(out, st, delta, index);
  }

  return appendDelta([], st, delta, index);
};

const appendDelta = (
  out: string[],
  st: State,
  delta: Json | undefined,
  index: number,
): string[] => {
  switch (str(get(delta, "type"))) {
    case "text_delta":
      return appendTextDelta(out, st, str(get(delta, "text")), false);
    case "thinking_delta":
      return appendTextDelta(out, st, str(get(delta, "thinking")), true);
    case "input_json_delta": {
      const partial = str(get(delta, "partial_json"));
      st.toolArgs.set(index, (st.toolArgs.get(index) ?? "") + partial);

      return appendArgumentsDelta(out, st, partial);
    }
  }

  return out;
};

const toolUseStep = (part: Json | undefined, argsRaw: string): JsonObject => {
  const step: JsonObject = { type: "function_call", name: str(get(part, "name")), arguments: {} };
  const id = str(get(part, "id"));

  if (id !== "") {
    step.id = id;
    step.call_id = id;
  }

  if (argsRaw !== "") {
    const parsed = tryParseJson(argsRaw);

    if (parsed !== undefined) step.arguments = parsed;
  }

  return step;
};

const textStep = (type: string, text: string): JsonObject => ({
  type,
  content: [{ type: "text", text }],
});

const blockToStep = (part: Json | undefined): JsonObject | undefined => {
  switch (str(get(part, "type"))) {
    case "text":
      return textStep("model_output", str(get(part, "text")));
    case "thinking":
      return textStep("thought", str(get(part, "thinking")));
    case "tool_use": {
      const input = get(part, "input");

      return toolUseStep(part, exists(input) ? JSON.stringify(input).trim() : "");
    }
  }

  return undefined;
};

const blockToStartStep = (block: Json | undefined, stepType: string): JsonObject => {
  const step: JsonObject = { type: stepType };

  if (stepType === "function_call") {
    step.name = str(get(block, "name"));
    const id = str(get(block, "id"));

    if (id !== "") {
      step.id = id;
      step.call_id = id;
    }

    step.arguments = {};
  }

  return step;
};

const knownIndexStep = (stepType: string, index: number, st: State): JsonObject => {
  const step: JsonObject = { type: stepType };

  if (stepType === "function_call") {
    step.name = st.toolNames.get(index) ?? "";
    const id = st.toolIds.get(index) ?? "";

    if (id !== "") {
      step.id = id;
      step.call_id = id;
    }

    step.arguments = {};
  }

  return step;
};

const nonStreamBlockStart = (root: Json | undefined, st: State): void => {
  const index = asInt(get(root, "index"));
  const block = get(root, "content_block");
  st.currentStepByIndex.set(index, blockStepType(str(get(block, "type"))));

  if (str(get(block, "type")) !== "tool_use") return;
  st.toolNames.set(index, str(get(block, "name")));
  st.toolIds.set(index, str(get(block, "id")));
  const input = get(block, "input");

  if (isObj(input) && JSON.stringify(input) !== "{}") st.toolArgs.set(index, JSON.stringify(input));
};

const nonStreamBlockDelta = (root: Json | undefined, st: State): void => {
  const index = asInt(get(root, "index"));
  const delta = get(root, "delta");
  const type = str(get(delta, "type"));
  let add: string | undefined;

  if (type === "text_delta") add = str(get(delta, "text"));
  else if (type === "thinking_delta") add = str(get(delta, "thinking"));
  else if (type === "input_json_delta") add = str(get(delta, "partial_json"));

  if (add !== undefined) st.toolArgs.set(index, (st.toolArgs.get(index) ?? "") + add);
};

const nonStreamBlockStop = (root: Json | undefined, st: State): JsonObject => {
  const index = asInt(get(root, "index"));
  const stepType = st.currentStepByIndex.get(index) ?? "";
  const text = st.toolArgs.get(index) ?? "";
  let step: JsonObject;

  switch (stepType) {
    case "thought":
      step = textStep("thought", text);
      break;
    case "function_call":
      step = toolUseStep(
        { id: st.toolIds.get(index) ?? "", name: st.toolNames.get(index) ?? "" },
        text.trim(),
      );
      break;
    default:
      step = textStep("model_output", text);
  }

  st.currentStepByIndex.delete(index);
  st.toolNames.delete(index);
  st.toolIds.delete(index);
  st.toolArgs.delete(index);

  return step;
};

const USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "thinking_tokens",
];

const mergeUsage = (st: State, usage: Json | undefined): void => {
  if (!exists(usage)) return;
  st.usageRaw ??= {};

  for (const key of USAGE_KEYS) {
    const value = get(usage, key);

    if (exists(value)) st.usageRaw[key] = value;
  }
};

const mergedUsage = (st: State): Json | undefined => st.usageRaw;

/** `setInteractionsUsageFromClaude`. */
const setUsage = (out: JsonObject, path: string, usage: Json | undefined): void => {
  if (!exists(usage)) return;
  // SAFETY: split always yields at least one element and these paths have at most two segments.
  const [first, second] = path.split(".") as [string, string | undefined];
  let target: JsonObject;

  if (second === undefined) {
    target = isObj(out[first]) ? out[first] : {};
    out[first] = target;
  } else {
    // SAFETY: the only caller passing a two-segment path is `setUsage({ interaction }, "interaction.usage", ...)`, so `out.interaction` is the `interaction` object that caller passed in.
    const parent = out[first] as JsonObject;
    target = isObj(parent[second]) ? parent[second] : {};
    parent[second] = target;
  }

  const inputTokens = asInt(get(usage, "input_tokens"));
  const outputTokens = asInt(get(usage, "output_tokens"));
  const cacheRead = asInt(get(usage, "cache_read_input_tokens"));
  const cacheCreation = asInt(get(usage, "cache_creation_input_tokens"));
  const thinkingTokens = asInt(get(usage, "thinking_tokens"));
  const hasInput = exists(get(usage, "input_tokens"));
  const hasOutput = exists(get(usage, "output_tokens"));

  if (hasInput) {
    target.input_tokens = inputTokens;
    target.total_input_tokens = inputTokens;
  }

  if (hasOutput) {
    target.output_tokens = outputTokens;
    target.total_output_tokens = outputTokens;
  }

  if (hasInput || hasOutput) target.total_tokens = inputTokens + outputTokens;

  if (cacheRead !== 0 || cacheCreation !== 0) {
    target.cached_tokens = cacheRead + cacheCreation;
    target.total_cached_tokens = cacheRead + cacheCreation;
  }

  if (thinkingTokens !== 0) {
    target.reasoning_tokens = thinkingTokens;
    target.total_thought_tokens = thinkingTokens;
  }
};

const appendCreated = (out: string[], st: State, modelName: string): string[] => {
  if (st.created) return out;
  st.id = firstNonEmpty(st.id, newInteractionId());
  out.push(
    sseEventData("interaction.created", {
      interaction: {
        id: st.id,
        status: "in_progress",
        object: "interaction",
        model: firstNonEmpty(st.model, modelName),
      },
      event_type: "interaction.created",
    }),
  );
  st.created = true;

  return appendStatusUpdate(out, st);
};

const appendStatusUpdate = (out: string[], st: State): string[] => {
  if (st.statusUpdated) return out;
  out.push(
    sseEventData("interaction.status_update", {
      interaction_id: st.id,
      status: "in_progress",
      event_type: "interaction.status_update",
    }),
  );
  st.statusUpdated = true;

  return out;
};

const appendStepStart = (
  out: string[],
  st: State,
  stepType: string,
  step: JsonObject,
): string[] => {
  st.activeStepIndex = st.stepIndex;
  st.activeStepType = stepType;
  st.activeStepOpen = true;
  out.push(
    sseEventData("step.start", { index: st.activeStepIndex, step, event_type: "step.start" }),
  );

  return out;
};

const appendTextDelta = (out: string[], st: State, text: string, thought: boolean): string[] => {
  const delta: JsonObject = thought
    ? { type: "thought_summary", content: { type: "text", text } }
    : { text, type: "text" };

  out.push(
    sseEventData("step.delta", { index: st.activeStepIndex, delta, event_type: "step.delta" }),
  );

  return out;
};

const appendArgumentsDelta = (out: string[], st: State, args: string): string[] => {
  out.push(
    sseEventData("step.delta", {
      index: st.activeStepIndex,
      delta: { arguments: args, type: "arguments_delta" },
      event_type: "step.delta",
    }),
  );

  return out;
};

const appendStepStop = (out: string[], st: State): string[] => {
  if (!st.activeStepOpen) return out;
  out.push(sseEventData("step.stop", { index: st.activeStepIndex, event_type: "step.stop" }));
  st.activeStepOpen = false;
  st.activeStepType = "";
  st.stepIndex++;

  return out;
};

const appendCompleted = (
  out: string[],
  st: State,
  modelName: string,
  root: Json | undefined,
): string[] => {
  if (st.completed) return out;
  out = appendCreated(out, st, modelName);
  const now = new Date().toISOString().replace(/\.\d+Z$/u, "Z");
  st.stopReason = firstNonEmpty(
    str(get(root, "delta.stop_reason")),
    str(get(root, "stop_reason")),
    st.stopReason,
  );

  const interaction: JsonObject = {
    id: st.id,
    status: interactionsStatus(st.stopReason),
    usage: {},
    created: now,
    updated: now,
    service_tier: "standard",
    object: "interaction",
    model: firstNonEmpty(st.model, modelName),
  };

  let usage = mergedUsage(st);

  if (!exists(usage)) usage = get(root, "usage");
  setUsage({ interaction }, "interaction.usage", usage);
  out.push(
    sseEventData("interaction.completed", { interaction, event_type: "interaction.completed" }),
  );
  st.completed = true;

  return out;
};

const appendDone = (out: string[], st: State): string[] => {
  if (st.done) return out;
  out.push(sseEventData("done", "[DONE]"));
  st.done = true;

  return out;
};

const blockStepType = (blockType: string): string => {
  if (blockType === "thinking") return "thought";

  if (blockType === "tool_use") return "function_call";

  return "model_output";
};

/** `claudeInteractionsStatus`: the Interactions terminal status of a Claude stop reason. */
const interactionsStatus = (stopReason: string): string => {
  switch (stopReason) {
    case "tool_use":
      return "requires_action";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "incomplete";
    default:
      return "completed";
  }
};

const deltaStepType = (deltaType: string): string => {
  if (deltaType === "thinking_delta") return "thought";

  if (deltaType === "input_json_delta") return "function_call";

  return "model_output";
};

export const claudeToInteractionsResponse: ResponseTransform = {
  stream: convertClaudeResponseToInteractions,
  nonStream: convertClaudeResponseToInteractionsNonStream,
};
