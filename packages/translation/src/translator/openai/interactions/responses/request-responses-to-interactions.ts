/**
 * OpenAI Responses client -> Interactions provider (request).
 *
 * Go source: internal/translator/openai/interactions/responses/interactions_openai_responses_request.go
 * (ConvertOpenAIResponsesRequestToInteractions and helpers).
 */
import {
  asBool,
  asFloat,
  asInt,
  cloneJson,
  del,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import {
  applyPatchDescription,
  applyPatchParameters,
  isApplyPatchCustomTool,
} from "../../../common/apply-patch.ts";
import { antigravityToolNameToUpstream } from "../../common/antigravity-tools.ts";
import {
  isDevinCodexAppAutomationUpdate,
  sanitizeDevinToolDescription,
} from "../../common/devin-tools.ts";
import { getStr, isArr, str } from "../../common/read.ts";
import {
  collectResponsesToolDescriptors,
  collectResponsesToolWinners,
  qualifyResponsesNamespaceToolName,
  responsesToolDescriptionOf,
  responsesToolParametersOf,
} from "../../../common/responses-tools.ts";
import { UserTurnDrops } from "../../../common/parts.ts";
import {
  firstExisting,
  firstNonEmpty,
  isAntigravityModel,
  isDevinModel,
  responsesContentPartToInteractions,
  responsesCustomToolCallToInteractions,
  responsesFunctionCallToInteractions,
  setJsonValue,
  textStep,
} from "./shared.ts";

const requestModel = (modelName: string, root: Json): string =>
  modelName.trim() !== "" ? modelName : getStr(root, "model");

/** `responsesInstructionsText`. */
const responsesInstructionsText = (instructions: Json): string => {
  if (typeof instructions === "string") return instructions;
  const text = get(instructions, "text");

  if (text !== undefined) return str(text);
  const parts = get(instructions, "content");

  if (isArr(parts)) {
    let out = "";

    for (const part of parts) {
      const t = getStr(part, "text");

      if (t !== "") out += t;
    }

    return out;
  }

  return str(instructions);
};

const isUnsendableAttachmentType = (partType: string): boolean =>
  partType === "input_file" || partType === "input_audio" || partType === "input_video";

/** `responsesUserTurnDrops`: only a real user turn can be refused. */
const userTurnDrops = (role: string, drops: UserTurnDrops): UserTurnDrops | undefined =>
  role === "" || role === "user" ? drops : undefined;

/** `appendResponsesContentToInteractions`. */
const appendContent = (
  step: JsonObject,
  content: Json | undefined,
  drops: UserTurnDrops | undefined,
): JsonObject => {
  const items: Json[] = [];
  let sendable = 0;

  const appendPart = (item: Json): void => {
    const part = responsesContentPartToInteractions(item);

    if (part === undefined) {
      const partType = getStr(item, "type");

      if (drops !== undefined && isUnsendableAttachmentType(partType)) drops.drop(partType);

      return;
    }

    items.push(part);

    if (part.type !== "text" || part.text !== "") sendable++;
  };

  if (typeof content === "string") {
    items.push({ type: "text", text: content });

    if (content !== "") sendable++;
  } else if (isArr(content)) {
    for (const item of content) appendPart(item);
  } else if (isJsonObject(content)) {
    appendPart(content);
  }

  if (drops !== undefined) drops.endTurn(sendable);

  if (items.length > 0) step.content = items;

  return step;
};

/** `responsesFunctionOutputToInteractions`. */
const functionOutputToInteractions = (
  item: Json,
  namesByCallId: Map<string, string>,
  forAntigravity: boolean,
): JsonObject => {
  const out: JsonObject = { type: "function_result", name: "", result: {} };
  const callId = firstNonEmpty(getStr(item, "call_id"), getStr(item, "id"));
  let name = getStr(item, "name");
  const ns = getStr(item, "namespace");

  if (ns !== "" && name !== "") name = qualifyResponsesNamespaceToolName(ns, name);

  if (name === "" && callId !== "") name = namesByCallId.get(callId) ?? "";

  if (name !== "") {
    if (forAntigravity) name = antigravityToolNameToUpstream(name);
    out.name = name;
  }

  if (callId !== "") out.call_id = callId;
  let result = get(item, "output");

  if (result === undefined) result = get(item, "result");
  setJsonValue(out, "result", result, {});

  return out;
};

const rememberCallName = (item: Json, namesByCallId: Map<string, string>): void => {
  const callId = firstNonEmpty(getStr(item, "call_id"), getStr(item, "id"));
  let name = getStr(item, "name");
  const ns = getStr(item, "namespace");

  if (ns !== "" && name !== "") name = qualifyResponsesNamespaceToolName(ns, name);

  if (callId !== "" && name !== "") namesByCallId.set(callId, name);
};

/**
 * `responsesReasoningToInteractions`: a Devin-sealed reasoning item goes back upstream as a thought step so the model
 * keeps its earlier thinking across tool-call turns. Items without a Devin signature stay out: other providers cannot
 * read them.
 */
const reasoningToInteractions = (item: Json): JsonObject | undefined => {
  const signature = getStr(item, "encrypted_content").trim();

  if (!signature.startsWith("sealed.v1.")) return undefined;
  const summary = get(item, "summary");
  const texts: string[] = [];

  if (isArr(summary)) {
    for (const part of summary) {
      const text = getStr(part, "text");

      if (text !== "") texts.push(text);
    }
  }

  return { ...textStep("thought", texts.join("\n\n")), signature };
};

/** `responsesInputItemToInteractions`. */
const inputItemToInteractions = (
  item: Json,
  namesByCallId: Map<string, string>,
  forAntigravity: boolean,
  drops: UserTurnDrops,
): JsonObject | undefined => {
  const type = getStr(item, "type");

  switch (type) {
    case "message": {
      let stepType = "user_input";
      const role = getStr(item, "role");
      let turnDrops = userTurnDrops(role, drops);

      if (role === "assistant" || role === "model") {
        stepType = "model_output";
        turnDrops = undefined;
      }

      return appendContent({ type: stepType, content: [] }, get(item, "content"), turnDrops);
    }

    case "function_call":
      rememberCallName(item, namesByCallId);

      return responsesFunctionCallToInteractions(item, forAntigravity);
    case "custom_tool_call":
      rememberCallName(item, namesByCallId);

      return responsesCustomToolCallToInteractions(item, forAntigravity);
    case "function_call_output":
    case "custom_tool_call_output":
      return functionOutputToInteractions(item, namesByCallId, forAntigravity);
    case "reasoning":
      return reasoningToInteractions(item);
    case "input_text":
    case "output_text":
    case "text":
      return textStep(type === "output_text" ? "model_output" : "user_input", getStr(item, "text"));
    case "input_image":
    case "output_image":
    case "input_file":
    case "input_audio":
    case "input_video": {
      let stepType = "user_input";
      let turnDrops: UserTurnDrops | undefined;

      if (type === "output_image") stepType = "model_output";
      else turnDrops = drops;

      return appendContent({ type: stepType, content: [] }, item, turnDrops);
    }

    default: {
      const content = get(item, "content");

      if (content !== undefined) {
        return appendContent(
          { type: "user_input", content: [] },
          content,
          userTurnDrops(getStr(item, "role"), drops),
        );
      }
    }
  }

  return undefined;
};

/** `setResponsesInputOnInteractions`. */
const setInput = (
  out: JsonObject,
  input: Json,
  forAntigravity: boolean,
  drops: UserTurnDrops,
): void => {
  const namesByCallId = new Map<string, string>();
  const items: Json[] = [];

  if (typeof input === "string") {
    items.push(textStep("user_input", input));
  } else if (isArr(input)) {
    for (const item of input) {
      const converted = inputItemToInteractions(item, namesByCallId, forAntigravity, drops);

      if (converted !== undefined) items.push(converted);
    }
  } else if (isJsonObject(input)) {
    const converted = inputItemToInteractions(input, namesByCallId, forAntigravity, drops);

    if (converted !== undefined) items.push(converted);
  }

  if (items.length > 0) out.input = items;
};

/** `appendResponsesToolsToInteractions`. */
const appendTools = (
  out: JsonObject,
  root: Json | undefined,
  forAntigravity: boolean,
  forDevin: boolean,
): void => {
  if (root === undefined) return;
  const target: Json = isArr(root) ? { tools: root } : root;
  const descriptors = collectResponsesToolDescriptors(target);

  if (descriptors.length === 0) return;
  const winners = collectResponsesToolWinners(target);
  const seen = new Set<string>();
  const toolItems: Json[] = [];

  for (const descriptor of descriptors) {
    const winner = winners.get(descriptor.name);

    if (winner === undefined || winner.order !== descriptor.order) continue;

    if (seen.has(descriptor.name)) continue;
    seen.add(descriptor.name);

    if (
      forDevin &&
      (isDevinCodexAppAutomationUpdate(descriptor.namespace, descriptor.localName) ||
        isDevinCodexAppAutomationUpdate("", descriptor.name))
    ) {
      continue;
    }

    const name = forAntigravity ? antigravityToolNameToUpstream(descriptor.name) : descriptor.name;
    const item: JsonObject = { type: "function", name };
    const applyPatch = isApplyPatchCustomTool(descriptor.tool);
    let desc = responsesToolDescriptionOf(descriptor.tool);

    if (applyPatch) desc = applyPatchDescription(descriptor.tool);

    if (desc !== "") {
      if (forDevin) desc = sanitizeDevinToolDescription(desc);

      item.description = desc;
    }

    if (applyPatch) {
      item.parameters = applyPatchParameters();
    } else if (descriptor.toolType === "custom") {
      item.parameters = {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      };
    } else {
      const params = responsesToolParametersOf(descriptor.tool);

      if (params !== undefined) item.parameters = cloneJson(params);
    }

    toolItems.push(item);
  }

  if (toolItems.length > 0) out.tools = toolItems;
};

/** `ConvertOpenAIResponsesRequestToInteractions`. */
export const convertOpenAIResponsesRequestToInteractions = (
  modelName: string,
  body: Json,
  stream: boolean,
): Json => {
  const drops = new UserTurnDrops();
  const root = body;
  const out: JsonObject = { model: "", input: [] };
  const model = requestModel(modelName, root);
  out.model = model;
  const streamField = get(root, "stream");

  if (streamField !== undefined) out.stream = asBool(streamField);
  else if (stream) out.stream = true;
  const instructions = get(root, "instructions");

  if (instructions !== undefined) out.system_instruction = responsesInstructionsText(instructions);

  const previous = firstNonEmpty(
    getStr(root, "previous_response_id"),
    getStr(root, "previous_interaction_id"),
  );

  if (previous !== "") out.previous_interaction_id = previous;

  const environmentId = firstNonEmpty(
    getStr(root, "environment_id"),
    getStr(root, "environment.id"),
  );

  if (environmentId !== "") out.environment_id = environmentId;
  const agentConfig = get(root, "agent_config");

  if (agentConfig !== undefined) out.agent_config = cloneJson(agentConfig);
  const forAntigravity = isAntigravityModel(model);
  const forDevin = isDevinModel(model) || !forAntigravity;
  const input = get(root, "input");

  if (input !== undefined) setInput(out, input, forAntigravity, drops);
  appendTools(out, root, forAntigravity, forDevin);

  const toolChoice = get(root, "tool_choice");

  if (toolChoice !== undefined) {
    if (isJsonObject(toolChoice)) {
      let tc: Json | undefined = cloneJson(toolChoice);

      let fnName = firstNonEmpty(
        getStr(toolChoice, "function.name"),
        getStr(toolChoice, "name"),
        getStr(toolChoice, "custom.name"),
      );

      const ns = firstNonEmpty(
        getStr(toolChoice, "namespace"),
        getStr(toolChoice, "function.namespace"),
        getStr(toolChoice, "custom.namespace"),
      );

      if (ns !== "" && fnName !== "") fnName = qualifyResponsesNamespaceToolName(ns, fnName);

      if (
        forDevin &&
        (isDevinCodexAppAutomationUpdate(ns, fnName) || isDevinCodexAppAutomationUpdate("", fnName))
      ) {
        tc = undefined;
      }

      if (forAntigravity && fnName !== "") fnName = antigravityToolNameToUpstream(fnName);

      if (fnName !== "" && tc !== undefined) {
        if (get(toolChoice, "function.name") !== undefined) set(tc, "function.name", fnName);
        else if (get(toolChoice, "name") !== undefined) set(tc, "name", fnName);
        else if (get(toolChoice, "custom.name") !== undefined) set(tc, "custom.name", fnName);
      }

      if (tc !== undefined) set(out, "generation_config.tool_choice", tc);
    } else {
      set(out, "generation_config.tool_choice", cloneJson(toolChoice));
    }
  }

  const effort = get(root, "reasoning.effort");

  if (typeof effort === "string")
    set(out, "generation_config.thinking_level", effort.trim().toLowerCase());
  const summary = get(root, "reasoning.summary");

  if (typeof summary === "string") set(out, "generation_config.thinking_summaries", summary);
  const format = get(root, "response_format") ?? get(root, "text.format");

  if (format !== undefined) out.response_format = cloneJson(format);

  const maxOutputTokens = firstExisting(
    get(root, "max_output_tokens"),
    get(root, "max_tokens"),
    get(root, "max_completion_tokens"),
  );

  if (isAntigravityModel(model)) {
    if (maxOutputTokens !== undefined && get(root, "agent_config.max_total_tokens") === undefined) {
      set(out, "agent_config.max_total_tokens", asInt(maxOutputTokens));
    }

    for (const knob of [
      "temperature",
      "top_p",
      "top_k",
      "stop_sequences",
      "max_output_tokens",
      "presence_penalty",
      "frequency_penalty",
      "candidate_count",
    ]) {
      del(out, `generation_config.${knob}`);
    }
  } else {
    if (maxOutputTokens !== undefined)
      set(out, "generation_config.max_output_tokens", asInt(maxOutputTokens));
    const temperature = get(root, "temperature");

    if (temperature !== undefined) set(out, "generation_config.temperature", asFloat(temperature));
    const topP = get(root, "top_p");

    if (topP !== undefined) set(out, "generation_config.top_p", asFloat(topP));
    const presence = get(root, "presence_penalty");

    if (presence !== undefined) set(out, "generation_config.presence_penalty", asFloat(presence));
    const frequency = get(root, "frequency_penalty");

    if (frequency !== undefined)
      set(out, "generation_config.frequency_penalty", asFloat(frequency));
    const stop = get(root, "stop");

    if (stop !== undefined) set(out, "generation_config.stop_sequences", cloneJson(stop));
  }

  const err = drops.err(out);

  if (err !== undefined) throw err;

  return out;
};
