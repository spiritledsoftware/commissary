/**
 * Antigravity provider -> Interactions client (response).
 *
 * Go source: internal/translator/antigravity/interactions/interactions_antigravity_response.go.
 */
import {
  asBool,
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
import type { ResponseContext, ResponseTransform } from "../../registry.ts";
import {
  disambiguatedToolNameMap,
  type NameMap,
  restoreSanitizedToolName,
} from "../../common/tool-names.ts";

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
  toolNameMap: NameMap;
}

let idCounter = 0;

const nanoId = (prefix: string): string => {
  idCounter++;

  return `${prefix}_${Date.now()}${String(idCounter % 1_000_000).padStart(6, "0")}`;
};

/** `unwrapAntigravityResponse` + `restoreAntigravityUsageMetadata`. */
const unwrapResponse = (root: Json | undefined): Json | undefined => {
  if (root === undefined) return undefined;
  const response = get(root, "response");
  const node = response !== undefined ? structuredClone(response) : structuredClone(root);

  if (
    isJsonObject(node) &&
    node["usageMetadata"] === undefined &&
    node["cpaUsageMetadata"] !== undefined
  ) {
    node["usageMetadata"] = node["cpaUsageMetadata"];
    delete node["cpaUsageMetadata"];
  }

  return node;
};

/** `restoreInteractionsFunctionNames`. */
const restoreFunctionNames = (root: Json | undefined, nameMap: NameMap): Json | undefined => {
  if (root === undefined || nameMap === undefined) return root;
  const candidates = get(root, "candidates");

  if (!isJsonArray(candidates)) return root;

  for (const candidate of candidates) {
    const parts = get(candidate, "content.parts");

    if (!isJsonArray(parts)) continue;

    for (const part of parts) {
      for (const field of ["functionCall", "functionResponse"]) {
        const nameResult = get(part, `${field}.name`);
        const name = asString(nameResult);

        if (name === "") continue;
        const restored = restoreSanitizedToolName(nameMap, name);

        if (typeof nameResult === "string" && restored === name) continue;
        set(part, `${field}.name`, restored);
      }
    }
  }

  return root;
};

/** `antigravityStreamPayloads`: one payload, or the `response` of every element of an array. */
const streamPayloads = (line: string): Array<Json | undefined> => {
  let trimmed = line.trim();
  const isData = trimmed.startsWith("data:");

  if (isData) trimmed = trimmed.slice(5).trim();

  // The bare sentinel is a terminator too (upstream ede07caf: Go no longer misparses it as a JSON array).
  if (trimmed === "[DONE]") return ["[DONE]"];
  const root = tryParseJson(trimmed);

  if (isJsonArray(root)) {
    const payloads: Json[] = [];

    for (const item of root) {
      const response = get(item, "response");
      payloads.push(response ?? item);
    }

    if (payloads.length > 0) return payloads;
  }

  return [root];
};

const signatureOf = (part: Json): string => {
  for (const path of [
    "thoughtSignature",
    "thought_signature",
    "extra_content.google.thought_signature",
  ]) {
    const signature = asString(get(part, path)).trim();

    if (signature !== "") return signature;
  }

  return "";
};

const usageNode = (root: Json | undefined): Json | undefined =>
  get(root, "usageMetadata") ?? get(root, "usage_metadata") ?? get(root, "cpaUsageMetadata");

const firstUsageInt = (usage: Json, ...paths: string[]): number => {
  for (const path of paths) {
    const value = get(usage, path);

    if (value !== undefined) return asInt(value);
  }

  return 0;
};

const usagePathExists = (usage: Json, ...paths: string[]): boolean =>
  paths.some((path) => get(usage, path) !== undefined);

const hasStreamUsage = (root: Json | undefined): boolean => {
  const usage = usageNode(root);

  if (usage === undefined) return false;

  return usagePathExists(
    usage,
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
  );
};

const setUsage = (out: Json, path: string, root: Json | undefined): void => {
  const usage = usageNode(root);

  if (usage === undefined) return;
  set(out, `${path}.input_tokens`, firstUsageInt(usage, "promptTokenCount", "prompt_token_count"));
  set(
    out,
    `${path}.output_tokens`,
    firstUsageInt(usage, "candidatesTokenCount", "candidates_token_count"),
  );

  if (usagePathExists(usage, "thoughtsTokenCount", "thoughts_token_count")) {
    set(
      out,
      `${path}.reasoning_tokens`,
      firstUsageInt(usage, "thoughtsTokenCount", "thoughts_token_count"),
    );
  }

  set(out, `${path}.total_tokens`, firstUsageInt(usage, "totalTokenCount", "total_token_count"));

  if (usagePathExists(usage, "cachedContentTokenCount", "cached_content_token_count")) {
    set(
      out,
      `${path}.cached_tokens`,
      firstUsageInt(usage, "cachedContentTokenCount", "cached_content_token_count"),
    );
  }
};

const setStreamUsage = (out: Json, path: string, root: Json | undefined): void => {
  const usage = usageNode(root);

  if (usage === undefined) return;
  const input = firstUsageInt(usage, "promptTokenCount", "prompt_token_count");
  set(out, `${path}.total_tokens`, firstUsageInt(usage, "totalTokenCount", "total_token_count"));
  set(out, `${path}.total_input_tokens`, input);
  set(out, `${path}.input_tokens_by_modality`, [{ modality: "text", tokens: input }]);
  set(
    out,
    `${path}.total_cached_tokens`,
    firstUsageInt(usage, "cachedContentTokenCount", "cached_content_token_count"),
  );
  set(
    out,
    `${path}.total_output_tokens`,
    firstUsageInt(usage, "candidatesTokenCount", "candidates_token_count"),
  );
  set(out, `${path}.total_tool_use_tokens`, 0);
  set(
    out,
    `${path}.total_thought_tokens`,
    firstUsageInt(usage, "thoughtsTokenCount", "thoughts_token_count"),
  );
};

const functionPartId = (part: Json): string => {
  const id = get(part, "id");

  if (id !== undefined) return asString(id);
  const callId = get(part, "call_id");

  return callId === undefined ? "" : asString(callId);
};

// --- stream -------------------------------------------------------------------------------------------------------------

const created = (st: StreamState, modelName: string): string =>
  sseEventData(
    "interaction.created",
    JSON.stringify({
      interaction: { id: st.id, status: "in_progress", object: "interaction", model: modelName },
      event_type: "interaction.created",
    }),
  );

const statusUpdate = (st: StreamState): string =>
  sseEventData(
    "interaction.status_update",
    JSON.stringify({
      interaction_id: st.id,
      status: "in_progress",
      event_type: "interaction.status_update",
    }),
  );

const completed = (st: StreamState, modelName: string, root: Json | undefined): string => {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const event: Json = {
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

  if (root !== undefined) setStreamUsage(event, "interaction.usage", root);
  st.completed = true;

  return sseEventData("interaction.completed", JSON.stringify(event));
};

const done = (st: StreamState): string[] => {
  if (st.done) return [];
  st.done = true;

  return [sseEventData("done", "[DONE]")];
};

const stepStart = (st: StreamState, stepType: string, part: Json | undefined): string[] => {
  st.stepId = nanoId("step");
  st.activeStepIndex = st.stepIndex;
  st.stepIndex++;
  st.activeStepType = stepType;
  st.activeStepOpen = true;
  const step: JsonObject = { type: stepType };

  if (stepType === "function_call" && part !== undefined) {
    const id = functionPartId(part) || st.stepId;
    step["id"] = id;
    step["call_id"] = id;
    step["name"] = asString(get(part, "name"));
    step["arguments"] = {};
  }

  return [
    sseEventData(
      "step.start",
      JSON.stringify({ index: st.activeStepIndex, step, event_type: "step.start" }),
    ),
  ];
};

const stepStop = (st: StreamState): string[] => {
  if (!st.activeStepOpen) return [];

  const out = sseEventData(
    "step.stop",
    JSON.stringify({ index: st.activeStepIndex, event_type: "step.stop" }),
  );

  st.activeStepOpen = false;
  st.activeStepType = "";

  return [out];
};

const ensureStep = (st: StreamState, stepType: string, part: Json | undefined): string[] => {
  if (st.activeStepOpen && st.activeStepType === stepType) return [];

  return [...stepStop(st), ...stepStart(st, stepType, part)];
};

const delta = (st: StreamState, body: JsonObject): string =>
  sseEventData(
    "step.delta",
    JSON.stringify({ index: st.activeStepIndex, delta: body, event_type: "step.delta" }),
  );

const thoughtSignature = (st: StreamState, part: Json): string[] => {
  const signature = signatureOf(part);

  if (signature === "") return [];

  return [
    ...ensureStep(st, "thought", undefined),
    delta(st, { signature, type: "thought_signature" }),
  ];
};

/** `appendAntigravityPartToInteractionsStream`: one frame per entry. */
const partToStream = (st: StreamState, part: Json): string[] => {
  const text = get(part, "text");

  if (text !== undefined && asString(text) !== "") {
    if (asBool(get(part, "thought"))) {
      return [
        ...ensureStep(st, "thought", undefined),
        delta(st, { content: { text: asString(text), type: "text" }, type: "thought_summary" }),
        ...thoughtSignature(st, part),
      ];
    }

    return [
      ...ensureStep(st, "model_output", undefined),
      delta(st, { text: asString(text), type: "text" }),
      ...thoughtSignature(st, part),
    ];
  }

  const functionCall = get(part, "functionCall");

  if (functionCall !== undefined) {
    const args = get(functionCall, "args");

    return [
      ...thoughtSignature(st, part),
      ...ensureStep(st, "function_call", functionCall),
      delta(st, {
        arguments: args === undefined ? "{}" : JSON.stringify(args),
        type: "arguments_delta",
      }),
      ...stepStop(st),
    ];
  }

  const functionResponse = get(part, "functionResponse");

  if (functionResponse !== undefined) {
    const result = get(functionResponse, "response");

    return [
      ...ensureStep(st, "function_result", functionResponse),
      delta(st, {
        type: "function_result",
        name: asString(get(functionResponse, "name")),
        result: result === undefined ? {} : structuredClone(result),
      }),
      ...stepStop(st),
    ];
  }

  return signatureOf(part) !== "" ? thoughtSignature(st, part) : [];
};

/** `ConvertAntigravityResponseToInteractions`. */
export const convertAntigravityResponseToInteractions = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  if (context.state.value === undefined) {
    const fresh: StreamState = {
      started: false,
      finished: false,
      completed: false,
      done: false,
      activeStepOpen: false,
      pendingUsage: undefined,
      usageAfterSeen: false,
      id: nanoId("interaction"),
      stepId: "",
      activeStepType: "",
      activeStepIndex: 0,
      stepIndex: 0,
      toolNameMap: disambiguatedToolNameMap(context.originalRequest),
    };

    context.state.value = fresh;
  }

  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  const st = context.state.value as StreamState;
  const modelName = context.model;
  const out: string[] = [];

  for (const payload of streamPayloads(line)) {
    if (payload === "[DONE]") {
      if (!st.completed) out.push(...stepStop(st), completed(st, modelName, st.pendingUsage));
      out.push(...done(st));
      continue;
    }

    const root = restoreFunctionNames(unwrapResponse(payload), st.toolNameMap);

    if (root === undefined) continue;

    if (!st.started) {
      out.push(created(st, modelName), statusUpdate(st));
      st.started = true;
    }

    const parts = get(root, "candidates.0.content.parts");

    if (isJsonArray(parts)) for (const part of parts) out.push(...partToStream(st, part));
    const finishReason = get(root, "candidates.0.finishReason");
    const hasFinish = finishReason !== undefined && asString(finishReason).trim() !== "";
    const frameHasUsage = hasStreamUsage(root);

    if (frameHasUsage) {
      st.pendingUsage = root;

      if (st.finished) st.usageAfterSeen = true;
    }

    if (hasFinish && !st.finished) {
      out.push(...stepStop(st));
      st.finished = true;

      if (frameHasUsage) st.usageAfterSeen = true;
    }

    // Complete only on usage observed at or after the finish frame; usage cached from earlier content frames is the
    // fallback for an explicit `[DONE]`, not a completion trigger (a later frame may carry the final usage).
    if (st.usageAfterSeen && st.finished && !st.completed) {
      out.push(completed(st, modelName, st.pendingUsage), ...done(st));
    }
  }

  return out;
};

// --- non-stream ---------------------------------------------------------------------------------------------------------

const thoughtStep = (signature: string, text: string): JsonObject => {
  const step: JsonObject = { type: "thought" };

  if (signature !== "") step["signature"] = signature;

  if (text !== "") step["content"] = [{ type: "text", text }];

  return step;
};

const inlineDataStep = (inline: Json): JsonObject | undefined => {
  const mimeType = asString(get(inline, "mimeType")) || asString(get(inline, "mime_type"));
  const data = asString(get(inline, "data"));

  if (mimeType === "" || data === "") return undefined;
  const lower = mimeType.toLowerCase();
  let contentType = "document";

  if (lower.startsWith("image/")) contentType = "image";
  else if (lower.startsWith("audio/")) contentType = "audio";
  else if (lower.startsWith("video/")) contentType = "video";

  return { type: "model_output", content: [{ type: contentType, mime_type: mimeType, data }] };
};

/** `antigravityPartToInteractionsSteps`. */
const partToSteps = (part: Json): JsonObject[] => {
  const sig = signatureOf(part);
  const functionCall = get(part, "functionCall");

  if (functionCall !== undefined) {
    const steps: JsonObject[] = [];

    if (sig !== "") steps.push(thoughtStep(sig, ""));

    const step: JsonObject = {
      type: "function_call",
      name: asString(get(functionCall, "name")),
      arguments: {},
    };

    const id = get(functionCall, "id");

    if (id !== undefined) step["call_id"] = asString(id);
    else {
      const callId = get(functionCall, "call_id");

      if (callId !== undefined) step["call_id"] = asString(callId);
    }

    const args = get(functionCall, "args");

    if (args !== undefined) step["arguments"] = structuredClone(args);
    steps.push(step);

    return steps;
  }

  const functionResponse = get(part, "functionResponse");

  if (functionResponse !== undefined) {
    const step: JsonObject = {
      type: "function_result",
      name: asString(get(functionResponse, "name")),
      result: {},
    };

    const id = get(functionResponse, "id");

    if (id !== undefined) step["call_id"] = asString(id);
    else {
      const callId = get(functionResponse, "call_id");

      if (callId !== undefined) step["call_id"] = asString(callId);
    }

    const response = get(functionResponse, "response");

    if (response !== undefined) step["result"] = structuredClone(response);

    return [step];
  }

  const text = get(part, "text");

  if (text !== undefined) {
    if (asBool(get(part, "thought"))) return [thoughtStep(sig, asString(text))];

    if (asString(text) === "") return sig !== "" ? [thoughtStep(sig, "")] : [];

    const steps: JsonObject[] = [
      { type: "model_output", content: [{ type: "text", text: asString(text) }] },
    ];

    if (sig !== "") steps.push(thoughtStep(sig, ""));

    return steps;
  }

  for (const key of ["inlineData", "inline_data"]) {
    const inline = get(part, key);

    if (inline === undefined) continue;
    const step = inlineDataStep(inline);

    if (step !== undefined) return sig !== "" ? [step, thoughtStep(sig, "")] : [step];
  }

  return sig !== "" ? [thoughtStep(sig, "")] : [];
};

/** `ConvertAntigravityResponseToInteractionsNonStream`. */
export const convertAntigravityResponseToInteractionsNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const root = restoreFunctionNames(
    unwrapResponse(tryParseJson(body)),
    disambiguatedToolNameMap(context.originalRequest),
  );

  const out: Json = { id: "", object: "interaction", status: "completed", model: "", steps: [] };
  set(out, "id", asString(get(root, "responseId")) || nanoId("interaction"));
  set(out, "model", context.model);
  const steps: Json[] = [];
  const parts = get(root, "candidates.0.content.parts");

  if (isJsonArray(parts)) for (const part of parts) steps.push(...partToSteps(part));

  if (steps.length > 0) set(out, "steps", steps);
  setUsage(out, "usage", root);

  return JSON.stringify(out);
};

export const antigravityToInteractionsResponse: ResponseTransform = {
  stream: convertAntigravityResponseToInteractions,
  nonStream: convertAntigravityResponseToInteractionsNonStream,
};
