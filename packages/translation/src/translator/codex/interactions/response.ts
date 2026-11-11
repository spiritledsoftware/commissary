/**
 * Codex (Responses) stream/non-stream response -> Interactions.
 *
 * Go source: internal/translator/codex/interactions/interactions_codex_response.go
 * (ConvertCodexResponseToInteractions, ConvertCodexResponseToInteractionsNonStream). The completion event embeds
 * the current time (`interaction.updated`), so tests control it through the platform clock (`Date`).
 */
import {
  asInt,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { sseEventData } from "../../common/bytes.ts";
import type { ResponseContext } from "../../registry.ts";

/** Go `codexToInteractionsStreamState`. */
interface StreamState {
  started: boolean;
  completed: boolean;
  done: boolean;
  activeStepOpen: boolean;
  activeStepType: string;
  activeStepIndex: number;
  stepIndex: number;
  id: string;
  model: string;
  createdAt: number;
  hasOutputText: boolean;
  /** Whether a summary delta streamed for the open thought step, so a done event does not repeat it. */
  hasThoughtSummary: boolean;
  /** Reasoning item ids whose summary streamed, keyed so a done-only item after a streamed one still emits its own. */
  readonly streamedSummaryItems: Set<string>;
  functionCallName: string;
  functionCallId: string;
  /** Repeated reasoning `output_item.done` events (item id + signature): one signature is one `thought_signature`. */
  readonly seenReasoningSignatures: Set<string>;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** `time.Format(time.RFC3339)` in UTC. */
const rfc3339 = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const mimeTypeFromOutputFormat = (outputFormat: string): string => {
  if (outputFormat === "") return "image/png";

  if (outputFormat.includes("/")) return outputFormat;

  switch (outputFormat.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
};

const itemCallId = (item: Json | undefined): string => {
  const callId = asString(get(item, "call_id")).trim();

  return callId !== "" ? callId : asString(get(item, "id")).trim();
};

const contentText = (content: Json | undefined): string => {
  for (const path of ["text", "content"]) {
    const value = get(content, path);

    if (typeof value === "string") return value;
  }

  return "";
};

const reasoningText = (item: Json | undefined): string => {
  const content = get(item, "content");

  if (content !== undefined) {
    if (typeof content === "string") return content;

    if (isJsonArray(content)) {
      const lines: string[] = [];

      for (const part of content) {
        let text = contentText(part);

        if (text === "") text = asString(get(part, "summary_text"));

        if (text !== "") lines.push(text);
      }

      return lines.join("\n");
    }
  }

  const summary = get(item, "summary");

  if (summary !== undefined) {
    if (typeof summary === "string") return summary;

    if (isJsonArray(summary)) {
      return summary
        .map((part) => contentText(part))
        .filter((text) => text !== "")
        .join("\n");
    }
  }

  return "";
};

/** `codexArgumentsJSON`: an object for the step arguments, or `undefined` when there is none. */
const argumentsObject = (args: Json | undefined): Json | undefined => {
  if (args === undefined) return undefined;

  if (typeof args === "string") {
    const parsed = tryParseJson(args);

    return isJsonObject(parsed) ? parsed : {};
  }

  return isJsonObject(args) ? args : undefined;
};

const setUsage = (out: Json, path: string, usage: Json | undefined, stream: boolean): Json => {
  if (usage === undefined) return out;
  let inputTokens = asInt(get(usage, "input_tokens"));
  let outputTokens = asInt(get(usage, "output_tokens"));

  if (inputTokens === 0) inputTokens = asInt(get(usage, "prompt_tokens"));

  if (outputTokens === 0) outputTokens = asInt(get(usage, "completion_tokens"));
  let totalTokens = asInt(get(usage, "total_tokens"));

  if (totalTokens === 0) totalTokens = inputTokens + outputTokens;
  let reasoningTokens = asInt(get(usage, "output_tokens_details.reasoning_tokens"));

  if (reasoningTokens === 0) reasoningTokens = asInt(get(usage, "reasoning_tokens"));
  let cachedTokens = asInt(get(usage, "input_tokens_details.cached_tokens"));

  if (cachedTokens === 0) cachedTokens = asInt(get(usage, "cached_tokens"));

  if (stream) {
    out = set(out, `${path}.total_tokens`, totalTokens);
    out = set(out, `${path}.total_input_tokens`, inputTokens);
    out = set(out, `${path}.input_tokens_by_modality`, [{ modality: "text", tokens: inputTokens }]);
    out = set(out, `${path}.total_cached_tokens`, cachedTokens);
    out = set(out, `${path}.total_output_tokens`, outputTokens);
    out = set(out, `${path}.total_tool_use_tokens`, 0);

    return set(out, `${path}.total_thought_tokens`, reasoningTokens);
  }

  out = set(out, `${path}.input_tokens`, inputTokens);
  out = set(out, `${path}.output_tokens`, outputTokens);
  out = set(out, `${path}.total_tokens`, totalTokens);

  if (reasoningTokens > 0) out = set(out, `${path}.reasoning_tokens`, reasoningTokens);

  if (cachedTokens > 0) out = set(out, `${path}.cached_tokens`, cachedTokens);

  return out;
};

const emit = (event: string, payload: Json): string => sseEventData(event, JSON.stringify(payload));

const appendCreated = (out: string[], st: StreamState, response: Json | undefined): string[] => {
  if (st.started) return out;
  const id = asString(get(response, "id"));

  if (id !== "") st.id = id;
  const model = asString(get(response, "model"));

  if (model !== "") st.model = model;
  const createdAt = get(response, "created_at");

  if (createdAt !== undefined) st.createdAt = asInt(createdAt);
  out.push(
    emit("interaction.created", {
      interaction: { id: st.id, status: "in_progress", object: "interaction", model: st.model },
      event_type: "interaction.created",
    }),
  );
  out.push(
    emit("interaction.status_update", {
      interaction_id: st.id,
      status: "in_progress",
      event_type: "interaction.status_update",
    }),
  );
  st.started = true;

  return out;
};

const appendCompleted = (out: string[], st: StreamState, response: Json | undefined): string[] => {
  if (st.completed) return out;
  const created = st.createdAt > 0 ? st.createdAt : nowSeconds();

  let completed: Json = {
    interaction: {
      id: st.id,
      status: "completed",
      usage: {},
      created: rfc3339(created),
      updated: rfc3339(nowSeconds()),
      service_tier: "standard",
      object: "interaction",
      model: st.model,
    },
    event_type: "interaction.completed",
  };

  const status = asString(get(response, "status"));

  if (status !== "") completed = set(completed, "interaction.status", status);
  completed = setUsage(completed, "interaction.usage", get(response, "usage"), true);
  out.push(emit("interaction.completed", completed));
  st.completed = true;

  return out;
};

const appendDone = (out: string[], st: StreamState): string[] => {
  if (st.done) return out;
  out.push(sseEventData("done", "[DONE]"));
  st.done = true;

  return out;
};

const appendStepStop = (out: string[], st: StreamState): string[] => {
  if (!st.activeStepOpen) return out;
  out.push(emit("step.stop", { index: st.activeStepIndex, event_type: "step.stop" }));

  if (st.activeStepType === "thought") st.hasThoughtSummary = false;
  st.activeStepOpen = false;
  st.activeStepType = "";

  return out;
};

const appendStepStart = (
  out: string[],
  st: StreamState,
  stepType: string,
  item: Json | undefined,
): string[] => {
  st.activeStepIndex = st.stepIndex;
  st.stepIndex++;
  st.activeStepOpen = true;
  st.activeStepType = stepType;

  if (stepType === "thought") st.hasThoughtSummary = false;

  let stepStart: Json = {
    index: st.activeStepIndex,
    step: { type: stepType },
    event_type: "step.start",
  };

  if (stepType === "function_call") {
    let name = asString(get(item, "name"));

    if (name === "") name = st.functionCallName;
    let callId = itemCallId(item);

    if (callId === "") callId = st.functionCallId;

    if (callId === "") callId = `step_${Date.now()}`;
    stepStart = set(stepStart, "step.id", callId);
    stepStart = set(stepStart, "step.call_id", callId);
    stepStart = set(stepStart, "step.name", name);
    stepStart = set(stepStart, "step.arguments", {});
  }

  out.push(emit("step.start", stepStart));

  return out;
};

const ensureStep = (
  out: string[],
  st: StreamState,
  stepType: string,
  item: Json | undefined,
): string[] => {
  if (st.activeStepOpen && st.activeStepType === stepType) return out;

  return appendStepStart(appendStepStop(out, st), st, stepType, item);
};

const textDelta = (st: StreamState, text: string): string =>
  emit("step.delta", {
    index: st.activeStepIndex,
    delta: { text, type: "text" },
    event_type: "step.delta",
  });

const thoughtDelta = (st: StreamState, text: string): string =>
  emit("step.delta", {
    index: st.activeStepIndex,
    delta: { content: { text, type: "text" }, type: "thought_summary" },
    event_type: "step.delta",
  });

const signatureDelta = (st: StreamState, signature: string): string =>
  emit("step.delta", {
    index: st.activeStepIndex,
    delta: { signature, type: "thought_signature" },
    event_type: "step.delta",
  });

const argumentsDelta = (st: StreamState, args: string): string =>
  emit("step.delta", {
    index: st.activeStepIndex,
    delta: { arguments: args, type: "arguments_delta" },
    event_type: "step.delta",
  });

const appendItemDone = (st: StreamState, item: Json | undefined): string[] => {
  let out = appendCreated([], st, undefined);

  switch (asString(get(item, "type"))) {
    case "message": {
      if (st.hasOutputText) return appendStepStop(out, st);
      const content = get(item, "content");

      if (isJsonArray(content)) {
        for (const part of content) {
          const text = contentText(part);

          if (text === "") continue;
          out = ensureStep(out, st, "model_output", item);
          out.push(textDelta(st, text));
        }
      }

      return appendStepStop(out, st);
    }

    case "reasoning": {
      const text = reasoningText(item);
      const signature = asString(get(item, "encrypted_content")).trim();

      if (signature !== "") {
        const key = `${asString(get(item, "id"))}\u0000${signature}`;

        if (st.seenReasoningSignatures.has(key)) return appendStepStop(out, st);
        st.seenReasoningSignatures.add(key);
      }

      const itemId = asString(get(item, "id")).trim();
      let hadStreamedSummary = st.hasThoughtSummary;

      if (itemId !== "" && st.streamedSummaryItems.size > 0) {
        hadStreamedSummary = st.streamedSummaryItems.has(itemId);
      }

      if (text !== "" && !hadStreamedSummary) {
        out = ensureStep(out, st, "thought", item);
        out.push(thoughtDelta(st, text));
      }

      if (signature !== "") {
        out = ensureStep(out, st, "thought", item);
        out.push(signatureDelta(st, signature));
      }

      // Completing a reasoning item resets the summary flag so a later done-only item is not suppressed.
      st.hasThoughtSummary = false;

      return appendStepStop(out, st);
    }

    case "function_call":
    case "tool_call":
      out = ensureStep(out, st, "function_call", item);
      out.push(argumentsDelta(st, asString(get(item, "arguments"))));

      return appendStepStop(out, st);
    case "image_generation_call": {
      const result = asString(get(item, "result"));

      if (result !== "") {
        out = ensureStep(out, st, "model_output", item);
        out.push(
          emit("step.delta", {
            index: st.activeStepIndex,
            delta: {
              content: {
                type: "image",
                mime_type: mimeTypeFromOutputFormat(asString(get(item, "output_format"))),
                data: result,
              },
              type: "content",
            },
            event_type: "step.delta",
          }),
        );
      }

      return appendStepStop(out, st);
    }
  }

  return out;
};

/** `ConvertCodexResponseToInteractions`. */
export const convertCodexResponseToInteractions = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  if (context.state.value === undefined) {
    const initial: StreamState = {
      started: false,
      completed: false,
      done: false,
      activeStepOpen: false,
      activeStepType: "",
      activeStepIndex: 0,
      stepIndex: 0,
      id: `interaction_${Date.now()}`,
      model: context.model,
      createdAt: 0,
      hasOutputText: false,
      hasThoughtSummary: false,
      streamedSummaryItems: new Set(),
      functionCallName: "",
      functionCallId: "",
      seenReasoningSignatures: new Set(),
    };

    context.state.value = initial;
  }

  // SAFETY: this translator is the only writer of `state.value` and initialises it to a StreamState before this read.
  const st = context.state.value as StreamState;
  let payload = line.trim();

  if (payload.startsWith("data:")) payload = payload.slice(5).trim();

  if (payload === "[DONE]") {
    let out = appendStepStop([], st);

    if (!st.completed) out = appendCompleted(out, st, undefined);

    return appendDone(out, st);
  }

  if (payload === "") return [];
  const root = tryParseJson(payload);

  switch (asString(get(root, "type"))) {
    case "response.created":
      return appendCreated([], st, get(root, "response"));
    case "response.output_item.added": {
      const out = appendCreated([], st, get(root, "response"));
      const item = get(root, "item");

      switch (asString(get(item, "type"))) {
        case "message":
          return ensureStep(out, st, "model_output", item);
        case "reasoning":
          return ensureStep(out, st, "thought", item);
        case "function_call":
        case "tool_call":
          st.functionCallName = asString(get(item, "name"));
          st.functionCallId = itemCallId(item);

          return ensureStep(out, st, "function_call", item);
      }

      return out;
    }

    case "response.output_text.delta": {
      let out = appendCreated([], st, get(root, "response"));
      out = ensureStep(out, st, "model_output", undefined);
      st.hasOutputText = true;
      out.push(textDelta(st, asString(get(root, "delta"))));

      return out;
    }

    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      let out = appendCreated([], st, get(root, "response"));
      out = ensureStep(out, st, "thought", undefined);
      out.push(thoughtDelta(st, asString(get(root, "delta"))));
      const itemId = asString(get(root, "item_id")).trim();

      if (itemId !== "") st.streamedSummaryItems.add(itemId);
      st.hasThoughtSummary = true;

      return out;
    }

    case "response.function_call_arguments.delta": {
      let out = appendCreated([], st, get(root, "response"));
      out = ensureStep(out, st, "function_call", get(root, "item"));
      out.push(argumentsDelta(st, asString(get(root, "delta"))));

      return out;
    }

    case "response.output_item.done":
      return appendItemDone(st, get(root, "item"));
    case "response.completed":
    case "response.incomplete": {
      let out = appendCreated([], st, get(root, "response"));
      out = appendStepStop(out, st);
      out = appendCompleted(out, st, get(root, "response"));

      return appendDone(out, st);
    }

    default:
      return [];
  }
};

const buildMessageStep = (item: Json | undefined): Json | undefined => {
  const contents: Json[] = [];
  const content = get(item, "content");

  if (isJsonArray(content)) {
    for (const part of content) {
      const text = contentText(part);

      if (text !== "") contents.push({ type: "text", text });
    }
  }

  return contents.length > 0 ? { type: "model_output", content: contents } : undefined;
};

const buildFunctionCallStep = (item: Json | undefined): Json => {
  const step: JsonObject = {
    type: "function_call",
    name: asString(get(item, "name")),
    arguments: {},
  };

  const callId = itemCallId(item);

  if (callId !== "") step["call_id"] = callId;
  const args = argumentsObject(get(item, "arguments"));

  if (args !== undefined) step["arguments"] = args;

  return step;
};

/** `ConvertCodexResponseToInteractionsNonStream`. */
export const convertCodexResponseToInteractionsNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = tryParseJson(body);
  const response = get(root, "response") ?? root;
  let out: Json = { id: "", object: "interaction", status: "completed", model: "", steps: [] };
  const status = asString(get(response, "status"));

  if (status !== "") out = set(out, "status", status);
  let id = asString(get(response, "id"));

  if (id === "") id = `interaction_${Date.now()}`;
  out = set(out, "id", id);
  const model = asString(get(response, "model"));
  out = set(out, "model", model !== "" ? model : context.model);
  const steps: Json[] = [];
  const output = get(response, "output");

  if (isJsonArray(output)) {
    for (const item of output) {
      switch (asString(get(item, "type"))) {
        case "message": {
          const step = buildMessageStep(item);

          if (step !== undefined) steps.push(step);
          break;
        }

        case "reasoning": {
          const text = reasoningText(item);
          const signature = asString(get(item, "encrypted_content")).trim();

          if (text === "" && signature === "") break;
          let step: Json = { type: "thought" };

          if (signature !== "") step = set(step, "signature", signature);

          if (text !== "") step = set(step, "content", [{ type: "text", text }]);
          steps.push(step);
          break;
        }

        case "function_call":
        case "tool_call":
          steps.push(buildFunctionCallStep(item));
          break;
        case "image_generation_call": {
          const result = asString(get(item, "result"));

          if (result !== "") {
            steps.push({
              type: "model_output",
              content: [
                {
                  type: "image",
                  mime_type: mimeTypeFromOutputFormat(asString(get(item, "output_format"))),
                  data: result,
                },
              ],
            });
          }

          break;
        }
      }
    }
  }

  if (steps.length > 0) out = set(out, "steps", steps);
  out = setUsage(out, "usage", get(response, "usage"), false);

  return JSON.stringify(out);
};
