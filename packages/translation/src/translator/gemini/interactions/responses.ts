/**
 * Interactions <-> Gemini response translators.
 *
 * Go source: internal/translator/gemini/interactions/interactions_gemini_common.go (ConvertGeminiResponseToInteractionsStream,
 * convertGeminiResponseToInteractionsNonStreamDirect, stream step helpers) and interactions_gemini_response.go
 * (ConvertInteractionsResponseToGemini[NonStream], passthrough converters). Generated interaction/step ids and
 * timestamps use the current time like Go.
 */
import {
  asBool,
  asInt,
  asString,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import {
  setGeminiFunctionResponseRaw,
  setGeminiFunctionResponseResult,
} from "../common/contents.ts";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";
import {
  firstNonBlankString,
  geminiPartToInteractionsSteps,
  geminiTextPartJson,
  interactionsContentPartToGeminiPart,
  interactionsFunctionPartId,
  interactionsThoughtSignature,
  interactionsUsage,
  setInteractionsStreamUsageFromGemini,
  geminiUsageNode,
  setInteractionsUsageFromGemini,
} from "./common.ts";

/** `translatorcommon.SSEEventData`. */
const sseEvent = (event: string, payload: Json | string): string =>
  `event: ${event}\ndata: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;

const nanos = (): string => `${Date.now()}000000`;

// --- Gemini provider -> Interactions client -----------------------------------------------------------------------------

interface StreamState {
  started: boolean;
  finished: boolean;
  completed: boolean;
  done: boolean;
  activeStepOpen: boolean;
  /** The latest frame carrying usage (the fallback for an explicit `[DONE]`). */
  pendingUsage: Json | undefined;
  usageAfterSeen: boolean;
  id: string;
  stepId: string;
  activeStepType: string;
  activeStepIndex: number;
  stepIndex: number;
}

const appendCreated = (out: string[], st: StreamState, modelName: string): void => {
  out.push(
    sseEvent("interaction.created", {
      interaction: { id: st.id, status: "in_progress", object: "interaction", model: modelName },
      event_type: "interaction.created",
    }),
  );
};

const appendStatusUpdate = (out: string[], st: StreamState): void => {
  out.push(
    sseEvent("interaction.status_update", {
      interaction_id: st.id,
      status: "in_progress",
      event_type: "interaction.status_update",
    }),
  );
};

const appendCompleted = (
  out: string[],
  st: StreamState,
  modelName: string,
  root: Json | undefined,
): void => {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const completed: JsonObject = {
    interaction: {
      id: st.id,
      status: "completed",
      usage: {},
      created: now,
      updated: now,
      service_tier: "standard",
      object: "interaction",
      model: modelName,
    },
    event_type: "interaction.completed",
  };

  if (root !== undefined)
    setInteractionsStreamUsageFromGemini(completed, "interaction.usage", root);
  out.push(sseEvent("interaction.completed", completed));
  st.completed = true;
};

const appendDone = (out: string[], st: StreamState): string[] => {
  if (st.done) return out;
  out.push(sseEvent("done", "[DONE]"));
  st.done = true;

  return out;
};

const appendStepStart = (
  out: string[],
  st: StreamState,
  stepType: string,
  part: Json | undefined,
): void => {
  st.stepId = `step_${nanos()}`;
  st.activeStepIndex = st.stepIndex;
  st.stepIndex++;
  st.activeStepType = stepType;
  st.activeStepOpen = true;
  const step: JsonObject = { type: stepType };

  if (stepType === "function_call") {
    step["id"] = interactionsFunctionPartId(part ?? null) || st.stepId;
    step["name"] = asString(get(part, "name"));
    step["arguments"] = {};
  }

  out.push(sseEvent("step.start", { index: st.activeStepIndex, step, event_type: "step.start" }));
};

const appendStepStop = (out: string[], st: StreamState): void => {
  if (!st.activeStepOpen) return;
  out.push(sseEvent("step.stop", { index: st.activeStepIndex, event_type: "step.stop" }));
  st.activeStepOpen = false;
  st.activeStepType = "";
};

const ensureStep = (
  out: string[],
  st: StreamState,
  stepType: string,
  part: Json | undefined,
): void => {
  if (st.activeStepOpen && st.activeStepType === stepType) return;
  appendStepStop(out, st);
  appendStepStart(out, st, stepType, part);
};

const appendThoughtSignature = (out: string[], st: StreamState, part: Json): void => {
  const signature = interactionsThoughtSignature(part);

  if (signature === "") return;
  ensureStep(out, st, "thought", undefined);
  out.push(
    sseEvent("step.delta", {
      index: st.activeStepIndex,
      delta: { signature, type: "thought_signature" },
      event_type: "step.delta",
    }),
  );
};

const appendGeminiPartToStream = (out: string[], st: StreamState, part: Json): void => {
  const text = get(part, "text");

  if (text !== undefined && asString(text) !== "") {
    if (asBool(get(part, "thought"))) {
      ensureStep(out, st, "thought", undefined);
      out.push(
        sseEvent("step.delta", {
          index: st.activeStepIndex,
          delta: { content: { text: asString(text), type: "text" }, type: "thought_summary" },
          event_type: "step.delta",
        }),
      );
      appendThoughtSignature(out, st, part);

      return;
    }

    ensureStep(out, st, "model_output", undefined);
    out.push(
      sseEvent("step.delta", {
        index: st.activeStepIndex,
        delta: { text: asString(text), type: "text" },
        event_type: "step.delta",
      }),
    );
    appendThoughtSignature(out, st, part);

    return;
  }

  const fc = get(part, "functionCall");

  if (fc !== undefined) {
    appendThoughtSignature(out, st, part);
    ensureStep(out, st, "function_call", fc);
    const args = get(fc, "args");
    out.push(
      sseEvent("step.delta", {
        index: st.activeStepIndex,
        delta: {
          arguments: args === undefined ? "{}" : JSON.stringify(args),
          type: "arguments_delta",
        },
        event_type: "step.delta",
      }),
    );
    appendStepStop(out, st);

    return;
  }

  const fr = get(part, "functionResponse");

  if (fr !== undefined) {
    ensureStep(out, st, "function_result", fr);

    const delta: JsonObject = {
      type: "function_result",
      name: asString(get(fr, "name")),
      result: {},
    };

    const response = get(fr, "response");

    if (response !== undefined) delta["result"] = response;
    out.push(
      sseEvent("step.delta", { index: st.activeStepIndex, delta, event_type: "step.delta" }),
    );
    appendStepStop(out, st);

    return;
  }

  if (interactionsThoughtSignature(part) !== "") appendThoughtSignature(out, st, part);
};

const hasGeminiStreamUsage = (root: Json): boolean => {
  const usage = geminiUsageNode(root);

  if (usage === undefined) return false;

  return [
    "promptTokenCount",
    "candidatesTokenCount",
    "totalTokenCount",
    "thoughtsTokenCount",
    "cachedContentTokenCount",
    "prompt_token_count",
    "candidates_token_count",
    "total_token_count",
    "thoughts_token_count",
    "cached_content_token_count",
  ].some((path) => exists(usage, path));
};

/** `ConvertGeminiResponseToInteractionsStream`. */
export const convertGeminiResponseToInteractions = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  const modelName = context.model;
  // Vertex stream paths pass SSE lines, while the Gemini executor passes bare payloads (upstream be929f07).
  let payload = line.trim();

  if (payload.startsWith("data:")) payload = payload.slice(5).trim();

  if (
    payload === "" ||
    payload.startsWith(":") ||
    payload.startsWith("event:") ||
    payload.startsWith("id:") ||
    payload.startsWith("retry:")
  ) {
    return [];
  }

  if (context.state.value === undefined) {
    context.state.value = {
      started: false,
      finished: false,
      completed: false,
      done: false,
      activeStepOpen: false,
      pendingUsage: undefined,
      usageAfterSeen: false,
      id: `interaction_${nanos()}`,
      stepId: "",
      activeStepType: "",
      activeStepIndex: 0,
      stepIndex: 0,
    } satisfies StreamState;
  }

  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  const st = context.state.value as StreamState;
  const out: string[] = [];

  if (payload === "[DONE]") {
    if (!st.completed) {
      appendStepStop(out, st);
      appendCompleted(out, st, modelName, st.pendingUsage);
    }

    return appendDone(out, st);
  }

  const root = tryParseJson(payload);

  if (!st.started) {
    appendCreated(out, st, modelName);
    appendStatusUpdate(out, st);
    st.started = true;
  }

  const parts = get(root, "candidates.0.content.parts");

  if (isJsonArray(parts)) for (const part of parts) appendGeminiPartToStream(out, st, part);
  const finishReason = get(root, "candidates.0.finishReason");
  const hasFinish = finishReason !== undefined && asString(finishReason).trim() !== "";
  const frameHasUsage = root !== undefined && hasGeminiStreamUsage(root);

  if (root !== undefined && frameHasUsage) {
    st.pendingUsage = root;

    if (st.finished) st.usageAfterSeen = true;
  }

  if (hasFinish && !st.finished) {
    appendStepStop(out, st);
    st.finished = true;

    if (frameHasUsage) st.usageAfterSeen = true;
  }

  // Complete only on usage observed at or after the finish frame; usage cached from earlier content frames is the
  // fallback for an explicit `[DONE]`, not a completion trigger (a later frame may carry the final usage).
  if (st.usageAfterSeen && st.finished && !st.completed) {
    appendCompleted(out, st, modelName, st.pendingUsage);
    appendDone(out, st);
  }

  return out;
};

/** `convertGeminiResponseToInteractionsNonStreamDirect`. */
export const convertGeminiResponseToInteractionsNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = tryParseJson(body);
  const id = asString(get(root, "responseId"));

  const out: JsonObject = {
    id: id === "" ? `interaction_${nanos()}` : id,
    object: "interaction",
    status: "completed",
    model: context.model,
    steps: [],
  };

  const steps: Json[] = [];
  const parts = get(root, "candidates.0.content.parts");

  if (isJsonArray(parts))
    for (const part of parts) steps.push(...geminiPartToInteractionsSteps(part));

  if (steps.length > 0) out["steps"] = steps;

  if (root !== undefined) setInteractionsUsageFromGemini(out, "usage", root);

  return JSON.stringify(out);
};

// --- Interactions provider -> Gemini client -----------------------------------------------------------------------------

interface ToGeminiState {
  id: string;
  model: string;
  serviceTier: string;
  stepNames: Map<number, string>;
  stepIds: Map<number, string>;
  stepSignatures: Map<number, string>;
}

const ssePayload = (raw: string): string | undefined => {
  const trimmed = raw.trim();

  if (trimmed === "" || trimmed === "[DONE]") return undefined;

  if (trimmed.startsWith("{")) return trimmed;
  const out: string[] = [];

  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.replace(/\r+$/, "").trim();

    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();

    if (data === "" || data === "[DONE]") continue;
    out.push(data);
  }

  return out.length === 0 ? undefined : out.join("\n");
};

const mapInteractionsErrorToGemini = (codeStr: string): readonly [number, string] => {
  const code = codeStr.trim();

  switch (code.toLowerCase()) {
    case "400":
    case "invalid_argument":
      return [400, "INVALID_ARGUMENT"];
    case "401":
    case "unauthenticated":
      return [401, "UNAUTHENTICATED"];
    case "403":
    case "permission_denied":
      return [403, "PERMISSION_DENIED"];
    case "404":
    case "not_found":
      return [404, "NOT_FOUND"];
    case "429":
    case "resource_exhausted":
    case "rate_limit_exceeded":
      return [429, "RESOURCE_EXHAUSTED"];
    case "499":
    case "canceled":
    case "cancelled":
      return [499, "CANCELLED"];
    case "503":
    case "unavailable":
      return [503, "UNAVAILABLE"];
    case "504":
    case "deadline_exceeded":
      return [504, "DEADLINE_EXCEEDED"];
    case "500":
    case "internal":
      return [500, "INTERNAL"];
    default: {
      const n = /^[+-]?\d+$/.test(code) ? Number.parseInt(code, 10) : Number.NaN;

      if (n >= 400 && n < 600) return n >= 500 ? [n, "INTERNAL"] : [n, "INVALID_ARGUMENT"];

      return [500, "INTERNAL"];
    }
  }
};

const usageInt = (usage: Json, ...paths: string[]): number | undefined => {
  for (const path of paths) {
    const value = get(usage, path);

    if (value !== undefined) return asInt(value);
  }

  return undefined;
};

const setGeminiUsageFromInteractions = (out: Json, usage: Json | undefined): void => {
  if (usage === undefined) return;
  const input = usageInt(usage, "input_tokens", "total_input_tokens");
  const output = usageInt(usage, "output_tokens", "total_output_tokens");
  const total = usageInt(usage, "total_tokens");

  if (input !== undefined) {
    set(out, "usageMetadata.promptTokenCount", input);
    set(out, "usageMetadata.promptTokensDetails", [{ modality: "TEXT", tokenCount: input }]);
  }

  if (output !== undefined) set(out, "usageMetadata.candidatesTokenCount", output);

  if (total !== undefined) set(out, "usageMetadata.totalTokenCount", total);
  else if (input !== undefined || output !== undefined)
    set(out, "usageMetadata.totalTokenCount", (input ?? 0) + (output ?? 0));
  const thoughts = usageInt(usage, "reasoning_tokens", "total_thought_tokens");

  if (thoughts !== undefined) set(out, "usageMetadata.thoughtsTokenCount", thoughts);
  const cached = usageInt(usage, "cached_tokens", "total_cached_tokens");

  if (cached !== undefined) set(out, "usageMetadata.cachedContentTokenCount", cached);
};

const buildGeminiChunk = (
  st: ToGeminiState,
  modelName: string,
  parts: Json[],
  finishReason: string,
  usage: Json | undefined,
  includeEmptyPart: boolean,
): Json => {
  const out: JsonObject = { candidates: [{ content: { parts: [], role: "model" }, index: 0 }] };
  const items = parts.length === 0 && includeEmptyPart ? [geminiTextPartJson("", false)] : parts;
  // SAFETY: `out` was built just above with `candidates` a one-element array of objects.
  const candidate = (out["candidates"] as JsonObject[])[0] as JsonObject;

  if (items.length > 0)
    // SAFETY: `candidate.content` is the `{ parts: [], role: "model" }` object literal built above.
    (candidate["content"] as JsonObject)["parts"] = items;

  if (finishReason !== "") candidate["finishReason"] = finishReason;
  const model = firstNonBlankString(st.model, modelName);

  if (model !== "") out["modelVersion"] = model;

  if (st.id !== "") out["responseId"] = st.id;

  if (st.serviceTier !== "") set(out, "usageMetadata.serviceTier", st.serviceTier);
  setGeminiUsageFromInteractions(out, usage);

  return out;
};

const interactionsContentToGeminiParts = (content: Json | undefined, thought: boolean): Json[] => {
  if (content === undefined) return [];

  if (typeof content === "string") return [geminiTextPartJson(content, thought)];

  if (isJsonObject(content)) {
    const part = interactionsContentPartToGeminiPart(content, thought);

    return part === undefined ? [] : [part];
  }

  const parts: Json[] = [];

  if (isJsonArray(content)) {
    for (const item of content) {
      const part = interactionsContentPartToGeminiPart(item, thought);

      if (part !== undefined) parts.push(part);
    }
  }

  return parts;
};

const firstExisting = (root: Json, ...paths: string[]): Json | undefined => {
  for (const path of paths) {
    const value = get(root, path);

    if (value !== undefined) return value;
  }

  return undefined;
};

/** `setInteractionsGeminiRawObject`: object-valued args (JSON text is parsed). */
const rawObjectValue = (value: Json | undefined): Json | undefined => {
  if (value === undefined) return {};

  if (typeof value === "string") {
    const raw = value.trim();

    if (raw !== "") {
      const parsed = tryParseJson(raw);

      if (parsed !== undefined) return parsed;
    }
  }

  return value;
};

const stepToGeminiParts = (step: Json): Json[] => {
  switch (asString(get(step, "type"))) {
    case "function_call": {
      const functionCall: JsonObject = { name: asString(get(step, "name")), args: {} };
      const id = firstNonBlankString(asString(get(step, "call_id")), asString(get(step, "id")));

      if (id !== "") functionCall["id"] = id;
      const part: JsonObject = { functionCall };

      const signature = firstNonBlankString(
        asString(get(step, "signature")),
        asString(get(step, "thoughtSignature")),
        asString(get(step, "thought_signature")),
      );

      if (signature !== "") part["thoughtSignature"] = signature;
      functionCall["args"] = rawObjectValue(firstExisting(step, "arguments", "args")) ?? {};

      return [part];
    }

    case "function_result": {
      const functionResponse: JsonObject = { name: asString(get(step, "name")), response: {} };
      const id = firstNonBlankString(asString(get(step, "call_id")), asString(get(step, "id")));

      if (id !== "") functionResponse["id"] = id;
      let part: Json = { functionResponse };
      const value = firstExisting(step, "result", "response");

      if (value === undefined) return [part];

      if (typeof value === "string") {
        const raw = value.trim();

        if (raw !== "" && tryParseJson(raw) !== undefined) {
          return [setGeminiFunctionResponseRaw(part, "functionResponse.response", raw)];
        }
      }

      part = setGeminiFunctionResponseResult(part, "functionResponse.response", value);

      return [part];
    }

    case "thought":
      return interactionsContentToGeminiParts(get(step, "content"), true);
    default:
      return interactionsContentToGeminiParts(get(step, "content"), false);
  }
};

const stepDeltaToGeminiChunk = (
  modelName: string,
  root: Json,
  st: ToGeminiState,
): Json | undefined => {
  const index = asInt(get(root, "index"));
  const delta = get(root, "delta");

  switch (asString(get(delta, "type"))) {
    case "arguments_delta": {
      const functionCall: JsonObject = {
        name: firstNonBlankString(st.stepNames.get(index) ?? "", asString(get(root, "step.name"))),
        args: {},
      };

      const id = st.stepIds.get(index) ?? "";

      if (id !== "") functionCall["id"] = id;
      const part: JsonObject = { functionCall };
      const signature = st.stepSignatures.get(index) ?? "";

      if (signature !== "") part["thoughtSignature"] = signature;
      const args = asString(get(delta, "arguments")).trim();

      if (args !== "") {
        const parsed = tryParseJson(args);

        if (parsed !== undefined) functionCall["args"] = parsed;
      }

      return buildGeminiChunk(st, modelName, [part], "", undefined, false);
    }

    case "text": {
      const text = firstNonBlankString(
        asString(get(delta, "text")),
        asString(get(delta, "content.text")),
      );

      return text === ""
        ? undefined
        : buildGeminiChunk(st, modelName, [geminiTextPartJson(text, false)], "", undefined, false);
    }

    case "thought_summary": {
      const text = firstNonBlankString(
        asString(get(delta, "content.text")),
        asString(get(delta, "text")),
      );

      return text === ""
        ? undefined
        : buildGeminiChunk(st, modelName, [geminiTextPartJson(text, true)], "", undefined, false);
    }

    case "thought_signature": {
      const signature = firstNonBlankString(
        asString(get(delta, "signature")),
        asString(get(delta, "thought_signature")),
        asString(get(delta, "thoughtSignature")),
      );

      if (signature === "") return undefined;
      st.stepSignatures.set(index, signature);
      const part = geminiTextPartJson("", true);
      part["thoughtSignature"] = signature;

      return buildGeminiChunk(st, modelName, [part], "", undefined, false);
    }

    default:
      return undefined;
  }
};

const convertInteractionsEventToGemini = (
  modelName: string,
  raw: string,
  st: ToGeminiState,
): string[] => {
  const payload = ssePayload(raw);

  if (payload === undefined) return [];
  const root = tryParseJson(payload);

  if (root === undefined) return [];

  switch (asString(get(root, "event_type"))) {
    case "interaction.created": {
      const interaction = get(root, "interaction");
      st.id = firstNonBlankString(st.id, asString(get(interaction, "id")));
      st.model = firstNonBlankString(st.model, asString(get(interaction, "model")), modelName);

      return [];
    }

    case "step.start": {
      const index = asInt(get(root, "index"));
      const step = get(root, "step");
      st.stepNames.set(index, asString(get(step, "name")));
      st.stepIds.set(
        index,
        firstNonBlankString(asString(get(step, "call_id")), asString(get(step, "id"))),
      );
      st.stepSignatures.set(
        index,
        firstNonBlankString(
          asString(get(step, "signature")),
          asString(get(step, "thoughtSignature")),
          asString(get(step, "thought_signature")),
        ),
      );

      return [];
    }

    case "step.delta": {
      const chunk = stepDeltaToGeminiChunk(modelName, root, st);

      return chunk === undefined ? [] : [JSON.stringify(chunk)];
    }

    case "interaction.completed":
    case "finish": {
      const interaction = get(root, "interaction");
      st.id = firstNonBlankString(st.id, asString(get(interaction, "id")));
      st.model = firstNonBlankString(st.model, asString(get(interaction, "model")), modelName);
      st.serviceTier = firstNonBlankString(
        st.serviceTier,
        asString(get(interaction, "service_tier")),
      );

      return [
        JSON.stringify(buildGeminiChunk(st, modelName, [], "STOP", interactionsUsage(root), true)),
      ];
    }

    case "response.failed":
    case "interaction.failed": {
      const errNode = get(root, "error") ?? get(root, "interaction.error");
      let message = asString(get(errNode, "message"));

      if (message === "") message = "upstream error occurred";

      const code = firstNonBlankString(
        asString(get(errNode, "code")),
        asString(get(root, "code")),
        asString(get(errNode, "status")),
      );

      const [status, statusText] = mapInteractionsErrorToGemini(code);

      return [JSON.stringify({ error: { code: status, message, status: statusText } })];
    }

    default:
      return [];
  }
};

const newToGeminiState = (model: string): ToGeminiState => ({
  id: "",
  model,
  serviceTier: "",
  stepNames: new Map(),
  stepIds: new Map(),
  stepSignatures: new Map(),
});

/** `ConvertInteractionsResponseToGemini`. */
export const convertInteractionsResponseToGemini = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  if (context.state.value === undefined) context.state.value = newToGeminiState(context.model);

  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  return convertInteractionsEventToGemini(
    context.model,
    line,
    context.state.value as ToGeminiState,
  );
};

/** `ConvertInteractionsResponseToGeminiNonStream`. */
export const convertInteractionsResponseToGeminiNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = tryParseJson(body);
  const interaction = get(root, "interaction") ?? root;
  const st = newToGeminiState(context.model);
  st.id = firstNonBlankString(
    asString(get(interaction, "id")),
    asString(get(root, "id")),
    `response_${nanos()}`,
  );
  st.model = firstNonBlankString(
    asString(get(interaction, "model")),
    asString(get(root, "model")),
    context.model,
  );
  st.serviceTier = firstNonBlankString(
    asString(get(interaction, "service_tier")),
    asString(get(root, "service_tier")),
  );
  const parts: Json[] = [];
  const steps = get(interaction, "steps") ?? get(root, "steps");

  if (isJsonArray(steps)) for (const step of steps) parts.push(...stepToGeminiParts(step));

  return JSON.stringify(
    buildGeminiChunk(st, context.model, parts, "STOP", interactionsUsage(root), true),
  );
};

/** `ConvertInteractionsResponsePassthrough`. */
export const convertInteractionsResponsePassthrough = (
  _context: ResponseContext,
  line: string,
): ReadonlyArray<string> => (line === "" ? [] : [line]);

export const convertInteractionsResponsePassthroughNonStream = (
  _context: ResponseContext,
  body: string,
): string => body;

export const geminiToInteractionsResponse: ResponseTransform = {
  stream: convertGeminiResponseToInteractions,
  nonStream: convertGeminiResponseToInteractionsNonStream,
};

export const interactionsToGeminiResponse: ResponseTransform = {
  stream: convertInteractionsResponseToGemini,
  nonStream: convertInteractionsResponseToGeminiNonStream,
};

export const interactionsPassthroughResponse: ResponseTransform = {
  stream: convertInteractionsResponsePassthrough,
  nonStream: convertInteractionsResponsePassthroughNonStream,
};
