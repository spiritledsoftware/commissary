/**
 * OpenAI Chat Completions provider -> Interactions client (response).
 *
 * Go source: internal/translator/openai/interactions/chat-completions/interactions_openai_response.go.
 * `time.Now()` based ids and timestamps are kept (the fixtures always carry upstream ids).
 */
import { asInt, get, type Json, type JsonObject } from "@commissary/json";
import { sseEvent } from "../../../../sse.ts";
import type { ResponseContext, ResponseTransform } from "../../../registry.ts";
import { antigravityToolNameToUpstream } from "../../common/antigravity-tools.ts";
import { getStr, isArr, str } from "../../common/read.ts";
import {
  firstNonEmpty,
  interactionsTextStep,
  isAntigravityModel,
  openAIReasoningTexts,
  openAIToolCallToInteractionsStep,
  parseJsonOrUndefined,
  setInteractionsUsageFromOpenAIChat,
  ssePayloadOf,
} from "./shared.ts";

/** Port of `openAIToInteractionsStreamState`. */
interface OpenAIToInteractionsState {
  created: boolean;
  statusUpdated: boolean;
  completed: boolean;
  done: boolean;
  currentStepType: string;
  currentStepId: string;
  toolCallIds: Map<number, string>;
  toolCallNames: Map<number, string>;
  id: string;
  stepIndex: number;
  activeStepIndex: number;
  activeStepOpen: boolean;
  usage: Json | undefined;
}

const nanosId = (prefix: string): string => `${prefix}_${Date.now()}000000`;

const nowRfc3339 = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const ev = (event: string, payload: Json): string => sseEvent(event, JSON.stringify(payload));

const appendStatusUpdate = (out: string[], st: OpenAIToInteractionsState): void => {
  if (st.statusUpdated) return;
  out.push(
    ev("interaction.status_update", {
      interaction_id: st.id,
      status: "in_progress",
      event_type: "interaction.status_update",
    }),
  );
  st.statusUpdated = true;
};

const appendCreated = (
  out: string[],
  st: OpenAIToInteractionsState,
  modelName: string,
  root: Json | undefined,
): void => {
  if (st.created) return;
  st.id = firstNonEmpty(getStr(root, "id"), st.id, nanosId("interaction"));
  out.push(
    ev("interaction.created", {
      interaction: {
        id: st.id,
        status: "in_progress",
        object: "interaction",
        model: firstNonEmpty(modelName, getStr(root, "model")),
      },
      event_type: "interaction.created",
    }),
  );
  st.created = true;
  appendStatusUpdate(out, st);
};

const appendStepStart = (
  out: string[],
  st: OpenAIToInteractionsState,
  stepType: string,
  step: Json,
): void => {
  const index = st.stepIndex;
  st.stepIndex++;
  st.activeStepIndex = index;
  st.currentStepType = stepType;
  st.activeStepOpen = true;
  const stepOut: JsonObject = { type: stepType };

  if (stepType === "function_call") {
    const id = firstNonEmpty(getStr(step, "id"), getStr(step, "call_id"), st.currentStepId);
    st.currentStepId = id;

    if (id !== "") stepOut.id = id;
    stepOut.name = getStr(step, "name");
    stepOut.arguments = {};
  } else {
    st.currentStepId = "";
  }

  out.push(ev("step.start", { index, step: stepOut, event_type: "step.start" }));
};

const appendStepStop = (out: string[], st: OpenAIToInteractionsState): void => {
  if (!st.activeStepOpen) return;
  out.push(ev("step.stop", { index: st.activeStepIndex, event_type: "step.stop" }));
  st.activeStepOpen = false;
  st.currentStepType = "";
  st.currentStepId = "";
};

const ensureStep = (
  out: string[],
  st: OpenAIToInteractionsState,
  modelName: string,
  stepType: string,
  step: Json,
): void => {
  appendCreated(out, st, modelName, step);

  if (st.activeStepOpen && st.currentStepType === stepType) return;
  appendStepStop(out, st);
  appendStepStart(out, st, stepType, step);
};

const appendTextDelta = (
  out: string[],
  st: OpenAIToInteractionsState,
  text: string,
  thought: boolean,
): void => {
  if (thought) {
    out.push(
      ev("step.delta", {
        index: st.activeStepIndex,
        delta: { content: { text, type: "text" }, type: "thought_summary" },
        event_type: "step.delta",
      }),
    );

    return;
  }

  out.push(
    ev("step.delta", {
      index: st.activeStepIndex,
      delta: { text, type: "text" },
      event_type: "step.delta",
    }),
  );
};

const appendArgumentsDelta = (out: string[], st: OpenAIToInteractionsState, args: string): void => {
  out.push(
    ev("step.delta", {
      index: st.activeStepIndex,
      delta: { arguments: args, type: "arguments_delta" },
      event_type: "step.delta",
    }),
  );
};

const appendCompleted = (
  out: string[],
  st: OpenAIToInteractionsState,
  modelName: string,
  root: Json | undefined,
): void => {
  if (st.completed) return;

  if (!st.created) appendCreated(out, st, modelName, root);
  const now = nowRfc3339();

  const payload: JsonObject = {
    interaction: {
      id: st.id,
      status: "completed",
      usage: {},
      created: now,
      updated: now,
      service_tier: "standard",
      object: "interaction",
      model: firstNonEmpty(modelName, getStr(root, "model")),
    },
    event_type: "interaction.completed",
  };

  let usage = get(root, "usage");

  if (usage === undefined) usage = st.usage;
  setInteractionsUsageFromOpenAIChat(payload, "interaction.usage", usage);
  out.push(ev("interaction.completed", payload));
  st.completed = true;
};

const appendDone = (out: string[], st: OpenAIToInteractionsState): void => {
  if (st.done) return;
  out.push(sseEvent("done", "[DONE]"));
  st.done = true;
};

const appendToolCallDelta = (
  out: string[],
  st: OpenAIToInteractionsState,
  modelName: string,
  root: Json,
  toolCall: Json,
): void => {
  const index = asInt(get(toolCall, "index"));
  const id = getStr(toolCall, "id");

  if (id !== "") st.toolCallIds.set(index, id);
  const fn = get(toolCall, "function");
  let name = getStr(fn, "name");

  if (name !== "") {
    if (isAntigravityModel(modelName)) name = antigravityToolNameToUpstream(name);
    st.toolCallNames.set(index, name);
  }

  const stepId = firstNonEmpty(st.toolCallIds.get(index) ?? "", `call_${index}`);
  const stepName = st.toolCallNames.get(index) ?? "";

  if (st.currentStepType !== "function_call" || st.currentStepId !== stepId) {
    appendStepStop(out, st);
    const step: JsonObject = { type: "function_call", id: stepId, name: stepName, arguments: {} };
    appendCreated(out, st, modelName, root);
    appendStepStart(out, st, "function_call", step);
  }

  const args = get(fn, "arguments");

  if (args !== undefined && str(args) !== "") appendArgumentsDelta(out, st, str(args));
};

const convertOpenAIChatStreamToInteractions = (
  modelName: string,
  rawLine: string,
  st: OpenAIToInteractionsState,
): string[] => {
  const payload = ssePayloadOf(rawLine);

  if (payload === "") return [];

  if (payload.trim() === "[DONE]") {
    const out: string[] = [];
    appendStepStop(out, st);

    if (!st.completed) appendCompleted(out, st, modelName, undefined);
    appendDone(out, st);

    return out;
  }

  const root = parseJsonOrUndefined(payload);

  if (root === undefined) return [];
  const usage = get(root, "usage");

  if (usage !== undefined) st.usage = usage;
  const out: string[] = [];
  const choices = get(root, "choices");

  if (isArr(choices)) {
    if (choices.length === 0) {
      if (get(root, "usage") !== undefined) {
        appendStepStop(out, st);
        appendCompleted(out, st, modelName, root);
      }

      return out;
    }

    for (const choice of choices) {
      const delta = get(choice, "delta");
      const reasoning = get(delta, "reasoning_content");

      if (reasoning !== undefined) {
        for (const text of openAIReasoningTexts(reasoning)) {
          ensureStep(out, st, modelName, "thought", root);
          appendTextDelta(out, st, text, true);
        }
      }

      const content = get(delta, "content");

      if (content !== undefined && str(content) !== "") {
        ensureStep(out, st, modelName, "model_output", root);
        appendTextDelta(out, st, str(content), false);
      }

      const toolCalls = get(delta, "tool_calls");

      if (isArr(toolCalls))
        for (const toolCall of toolCalls) appendToolCallDelta(out, st, modelName, root, toolCall);

      // Only a non-empty finish_reason closes the step: a null one keeps it open (Go 3dc07c08).
      const finishReason = get(choice, "finish_reason");

      if (typeof finishReason === "string" && finishReason.trim() !== "") appendStepStop(out, st);
    }
  }

  return out;
};

/** `ConvertOpenAIResponseToInteractions`. */
export const convertOpenAIResponseToInteractions = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  if (context.state.value === undefined) {
    context.state.value = {
      created: false,
      statusUpdated: false,
      completed: false,
      done: false,
      currentStepType: "",
      currentStepId: "",
      toolCallIds: new Map(),
      toolCallNames: new Map(),
      id: "",
      stepIndex: 0,
      activeStepIndex: 0,
      activeStepOpen: false,
      usage: undefined,
    } satisfies OpenAIToInteractionsState;
  }

  // SAFETY: only this translator writes `state.value`, and it is set to an OpenAIToInteractionsState before this call.
  return convertOpenAIChatStreamToInteractions(
    context.model,
    line,
    context.state.value as OpenAIToInteractionsState,
  );
};

/** `ConvertOpenAIResponseToInteractionsNonStream`. */
export const convertOpenAIResponseToInteractionsNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const modelName = context.model;
  const root: Json = parseJsonOrUndefined(body) ?? {};

  const out: JsonObject = {
    id: firstNonEmpty(getStr(root, "id"), nanosId("interaction")),
    status: "completed",
    object: "interaction",
    model: firstNonEmpty(modelName, getStr(root, "model")),
    steps: [],
  };

  const steps: Json[] = [];
  const choices = get(root, "choices");

  if (isArr(choices)) {
    for (const choice of choices) {
      const message = get(choice, "message");
      const reasoning = get(message, "reasoning_content");

      if (reasoning !== undefined) {
        for (const text of openAIReasoningTexts(reasoning))
          steps.push(interactionsTextStep("thought", text));
      }

      const content = get(message, "content");

      if (content !== undefined && str(content) !== "")
        steps.push(interactionsTextStep("model_output", str(content)));
      const toolCalls = get(message, "tool_calls");

      if (isArr(toolCalls)) {
        const forAntigravity = isAntigravityModel(modelName);

        for (const toolCall of toolCalls) {
          const step = openAIToolCallToInteractionsStep(toolCall, forAntigravity);

          if (step !== undefined) steps.push(step);
        }
      }

      const finishReason = get(choice, "finish_reason");

      if (finishReason !== undefined) out.finish_reason = str(finishReason);
    }
  }

  if (steps.length > 0) out.steps = steps;
  setInteractionsUsageFromOpenAIChat(out, "usage", get(root, "usage"));

  return JSON.stringify(out);
};

export const openAIToInteractionsResponse: ResponseTransform = {
  stream: convertOpenAIResponseToInteractions,
  nonStream: convertOpenAIResponseToInteractionsNonStream,
};
