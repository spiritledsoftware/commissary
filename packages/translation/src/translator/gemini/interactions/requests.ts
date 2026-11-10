/**
 * Interactions <-> Gemini request translators.
 *
 * Go source: internal/translator/gemini/interactions/interactions_gemini_common.go (ConvertInteractionsRequestToGemini,
 * ConvertGeminiRequestToInteractions and their helpers), interactions_gemini_response.go
 * (ConvertInteractionsRequestToInteractions).
 */
import {
  asBool,
  asString,
  del,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import { normalizeJsonSchemaNumericConstraints } from "../../common/schema.ts";
import { reorderGeminiUserParts, setGeminiFunctionResponseResult } from "../common/contents.ts";
import {
  geminiPartIsSendable,
  interactionsAttachmentType,
  isInteractionsInstructionStep,
  UserRun,
  UserTurnDrops,
} from "../../common/parts.ts";
import {
  convertCamelCaseKeysToSnakeCase,
  convertSnakeCaseKeysToCamelCase,
  firstExistingPath,
  firstNonEmptyString,
  geminiFileDataPartJson,
  geminiInlineDataPartJson,
  geminiPartFileData,
  geminiPartToInteractionsContent,
  geminiPartToInteractionsSteps,
  geminiTextPartJson,
  interactionsContentPartToGeminiPart,
  interactionsGeminiContent,
} from "./common.ts";

// --- Gemini -> Interactions ---------------------------------------------------------------------------------------------

const geminiSystemInstructionText = (sys: Json | undefined): string => {
  if (sys === undefined) return "";

  if (typeof sys === "string") return sys;
  const text = get(sys, "text");

  if (typeof text === "string") return text;
  const parts = get(sys, "parts");

  if (!isJsonArray(parts)) return "";

  return parts
    .map((part) => asString(get(part, "text")))
    .filter((value) => value !== "")
    .join("\n");
};

const normalizeGeminiThinkingConfigForInteractions = (out: Json): void => {
  const level = firstExistingPath(out, [
    "generation_config.thinking_config.thinking_level",
    "generation_config.thinkingConfig.thinkingLevel",
    "generation_config.thinkingConfig.thinking_level",
  ]);

  if (level !== undefined)
    set(out, "generation_config.thinking_level", asString(level).trim().toLowerCase());

  const budget = firstExistingPath(out, [
    "generation_config.thinking_config.thinking_budget",
    "generation_config.thinkingConfig.thinkingBudget",
    "generation_config.thinkingConfig.thinking_budget",
  ]);

  if (budget !== undefined) set(out, "generation_config.thinking_budget", budget);

  if (get(out, "generation_config.thinking_summaries") === undefined) {
    const include = firstExistingPath(out, [
      "generation_config.thinking_config.include_thoughts",
      "generation_config.thinking_config.includeThoughts",
      "generation_config.thinkingConfig.include_thoughts",
      "generation_config.thinkingConfig.includeThoughts",
    ]);

    if (include !== undefined)
      set(out, "generation_config.thinking_summaries", asBool(include) ? "auto" : "none");
  }
};

const isNonEmptyObject = (value: Json | undefined): value is JsonObject =>
  isJsonObject(value) && Object.keys(value).length > 0;

const builtinToolEntry = (type: string, node: Json): JsonObject => {
  const entry: JsonObject = { type };

  if (isNonEmptyObject(node)) entry[type] = node;

  return entry;
};

const functionToolEntry = (source: Json): JsonObject => {
  const entry: JsonObject = { type: "function", name: asString(get(source, "name")) };
  const description = get(source, "description");

  if (description !== undefined) entry["description"] = asString(description);
  const params = get(source, "parameters") ?? get(source, "parametersJsonSchema");

  if (params !== undefined) entry["parameters"] = normalizeJsonSchemaNumericConstraints(params);

  return entry;
};

const copyGeminiToolsToInteractions = (out: Json, root: Json): void => {
  const tools = get(root, "tools");

  if (tools === undefined) return;

  if (!isJsonArray(tools)) {
    set(out, "tools", tools);

    return;
  }

  const normalized: Json[] = [];

  for (const tool of tools) {
    const urlContext = get(tool, "urlContext") ?? get(tool, "url_context");

    if (urlContext !== undefined) normalized.push(builtinToolEntry("url_context", urlContext));
    const codeExecution = get(tool, "codeExecution") ?? get(tool, "code_execution");

    if (codeExecution !== undefined)
      normalized.push(builtinToolEntry("code_execution", codeExecution));
    const googleSearch = get(tool, "googleSearch") ?? get(tool, "google_search");

    if (googleSearch !== undefined)
      normalized.push(builtinToolEntry("google_search", googleSearch));

    if (exists(tool, "name")) {
      normalized.push(functionToolEntry(tool));
      continue;
    }

    const decls = get(tool, "functionDeclarations") ?? get(tool, "function_declarations");

    if (isJsonArray(decls)) {
      for (const decl of decls) if (exists(decl, "name")) normalized.push(functionToolEntry(decl));
    }
  }

  set(out, "tools", normalized.length === 0 ? tools : normalized);
};

const pushSteps = (items: Json[], part: Json): number => {
  let sendable = 0;

  for (const step of geminiPartToInteractionsSteps(part)) {
    items.push(step);
    sendable++;
  }

  return sendable;
};

/** `ConvertGeminiRequestToInteractions`. */
export const convertGeminiRequestToInteractions = (
  modelName: string,
  request: Json,
  stream: boolean,
): Json => {
  const drops = new UserTurnDrops();
  const out: JsonObject = { model: modelName, input: [] };
  const sys = get(request, "systemInstruction") ?? get(request, "system_instruction");
  const text = geminiSystemInstructionText(sys);

  if (text !== "") out["system_instruction"] = text;
  const generationConfig = get(request, "generationConfig");

  if (generationConfig !== undefined) {
    out["generation_config"] = convertCamelCaseKeysToSnakeCase(generationConfig);
    normalizeGeminiThinkingConfigForInteractions(out);
  }

  copyGeminiToolsToInteractions(out, request);

  const inputItems: Json[] = [];
  const contents = get(request, "contents");

  for (const content of isJsonArray(contents) ? contents : []) {
    const role = asString(get(content, "role"));
    const stepType = role === "model" ? "model_output" : "user_input";
    let sendable = 0;
    const parts = get(content, "parts");

    for (const part of isJsonArray(parts) ? parts : []) {
      if (exists(part, "functionCall") || exists(part, "functionResponse")) {
        sendable += pushSteps(inputItems, part);
        continue;
      }

      const partText = get(part, "text");

      if (partText !== undefined && asString(partText) === "") {
        // Empty text becomes a signature carrier (when it has one) but does not count as sendable.
        pushSteps(inputItems, part);
        continue;
      }

      const item = geminiPartToInteractionsContent(part);

      if (item === undefined) {
        if (role !== "model" && geminiPartFileData(part) !== undefined) drops.drop("fileData");
        continue;
      }

      const currentStepType =
        asBool(get(part, "thought")) && role === "model" ? "thought" : stepType;

      inputItems.push({ type: currentStepType, content: [item] });
      sendable++;
    }

    if (role !== "model") drops.endTurn(sendable);
  }

  out["input"] = inputItems;
  out["stream"] = stream;
  const error = drops.err(out);

  if (error !== undefined) throw error;

  return out;
};

// --- Interactions -> Gemini ---------------------------------------------------------------------------------------------

const copyInteractionsSystemInstruction = (out: Json, root: Json): void => {
  const sys = get(root, "system_instruction");

  if (sys === undefined) return;

  if (typeof sys === "string") {
    set(out, "systemInstruction", { parts: [{ text: sys }] });

    return;
  }

  const text = get(sys, "text");

  if (text !== undefined && get(sys, "parts") === undefined) {
    set(out, "systemInstruction", { parts: [{ text: asString(text) }] });

    return;
  }

  set(out, "systemInstruction", sys);
};

const interactionsThinkingSummariesIncludeThoughts = (
  summary: Json | undefined,
): boolean | undefined => {
  if (typeof summary !== "string") return undefined;

  switch (summary.trim().toLowerCase()) {
    case "auto":
      return true;
    case "none":
      return false;
    default:
      return undefined;
  }
};

const normalizeInteractionsGenerationConfig = (out: Json): void => {
  if (exists(out, "generationConfig.toolChoice")) del(out, "generationConfig.toolChoice");
  const level = get(out, "generationConfig.thinkingLevel");

  if (level !== undefined) {
    set(out, "generationConfig.thinkingConfig.thinkingLevel", level);
    del(out, "generationConfig.thinkingLevel");
  }

  const budget = get(out, "generationConfig.thinkingBudget");

  if (budget !== undefined) {
    set(out, "generationConfig.thinkingConfig.thinkingBudget", budget);
    del(out, "generationConfig.thinkingBudget");
  }

  const include = get(out, "generationConfig.includeThoughts");

  if (include !== undefined) {
    set(out, "generationConfig.thinkingConfig.includeThoughts", include);
    del(out, "generationConfig.includeThoughts");
  }

  const summaries = get(out, "generationConfig.thinkingSummaries");

  if (summaries !== undefined) {
    const includeThoughts = interactionsThinkingSummariesIncludeThoughts(summaries);

    if (includeThoughts !== undefined)
      set(out, "generationConfig.thinkingConfig.includeThoughts", includeThoughts);
    del(out, "generationConfig.thinkingSummaries");
  }
};

const copyInteractionsGenerationConfig = (out: Json, root: Json): void => {
  const cfg = get(root, "generation_config");

  if (cfg === undefined) {
    const camel = get(root, "generationConfig");

    if (camel === undefined) return;
    set(out, "generationConfig", camel);
    normalizeInteractionsGenerationConfig(out);

    return;
  }

  set(out, "generationConfig", convertSnakeCaseKeysToCamelCase(cfg));
  normalizeInteractionsGenerationConfig(out);
};

const copyInteractionsResponseModalities = (out: Json, root: Json): void => {
  const mods = get(root, "response_modalities") ?? get(root, "responseModalities");

  if (!isJsonArray(mods)) return;
  const responseMods: string[] = [];

  for (const mod of mods) {
    switch (asString(mod).trim().toLowerCase()) {
      case "text":
        responseMods.push("TEXT");
        break;
      case "image":
        responseMods.push("IMAGE");
        break;
      case "audio":
        responseMods.push("AUDIO");
        break;
      default:
        break;
    }
  }

  if (responseMods.length > 0) set(out, "generationConfig.responseModalities", responseMods);
};

const copyInteractionsToolChoice = (out: Json, root: Json): void => {
  const toolChoice =
    get(root, "tool_choice") ??
    get(root, "generation_config.tool_choice") ??
    get(root, "generationConfig.toolChoice");

  if (toolChoice === undefined) return;
  let mode = "";
  const allowedNames: string[] = [];

  const modeOf = (value: string): string => {
    switch (value) {
      case "none":
        return "NONE";
      case "auto":
        return "AUTO";
      case "required":
      case "any":
        return "ANY";
      default:
        return "";
    }
  };

  if (typeof toolChoice === "string") {
    mode = modeOf(toolChoice.trim().toLowerCase());
  } else if (isJsonObject(toolChoice)) {
    const toolType = asString(toolChoice["type"]).trim().toLowerCase();
    mode = modeOf(toolType);

    if (toolType === "function") {
      mode = "ANY";
      const name = asString(get(toolChoice, "function.name")).trim();

      if (name !== "") allowedNames.push(name);
    } else if (toolType === "tool") {
      mode = "ANY";
      const name = asString(toolChoice["name"]).trim();

      if (name !== "") allowedNames.push(name);
    }
  }

  if (mode === "") return;
  set(out, "toolConfig.functionCallingConfig.mode", mode);

  if (allowedNames.length > 0)
    set(out, "toolConfig.functionCallingConfig.allowedFunctionNames", allowedNames);
};

const copyInteractionsServiceTier = (out: Json, root: Json): void => {
  const serviceTier = get(root, "service_tier");

  if (typeof serviceTier === "string") set(out, "service_tier", serviceTier);
};

const interactionsBuiltinEntry = (
  key: string,
  tool: Json,
  snake: string,
  camel: string,
): JsonObject => {
  const raw = get(tool, snake);
  const alt = get(tool, camel);

  return { [key]: isJsonObject(raw) ? raw : isJsonObject(alt) ? alt : {} };
};

const copyInteractionsTools = (out: Json, root: Json): void => {
  const tools = get(root, "tools");

  if (tools === undefined) return;

  if (!isJsonArray(tools)) {
    set(out, "tools", tools);

    return;
  }

  if (tools.some((tool) => exists(tool, "functionDeclarations"))) {
    set(out, "tools", tools);

    return;
  }

  const normalized: Json[] = [];

  for (const tool of tools) {
    let entry: JsonObject | undefined = {};
    const toolType = asString(get(tool, "type"));

    switch (toolType) {
      case "url_context":
        entry = interactionsBuiltinEntry("urlContext", tool, "url_context", "urlContext");
        break;
      case "code_execution":
        entry = interactionsBuiltinEntry("codeExecution", tool, "code_execution", "codeExecution");
        break;
      case "google_search":
      case "web_search":
        entry = interactionsBuiltinEntry("googleSearch", tool, "google_search", "googleSearch");
        break;
      default: {
        const decls = get(tool, "function_declarations");

        if (isJsonArray(decls)) {
          entry = { functionDeclarations: decls };
        } else if (exists(tool, "name")) {
          const decl: JsonObject = { name: asString(get(tool, "name")) };
          const description = get(tool, "description");

          if (description !== undefined) decl["description"] = asString(description);
          const params = get(tool, "parameters");

          if (params !== undefined) decl["parameters"] = params;
          entry = { functionDeclarations: [decl] };
        } else if (isJsonObject(tool)) {
          const rawMap: JsonObject = structuredClone(tool);

          if (toolType === "") {
            for (const [from, to] of [
              ["url_context", "urlContext"],
              ["code_execution", "codeExecution"],
              ["google_search", "googleSearch"],
              ["web_search", "googleSearch"],
            ] as const) {
              if (Object.hasOwn(rawMap, from)) {
                // SAFETY: `Object.hasOwn(rawMap, from)` was checked above, so the key is present; the cast only drops the `undefined` added by noUncheckedIndexedAccess.
                rawMap[to] = rawMap[from] as Json;
                delete rawMap[from];
              }
            }
          }

          entry = rawMap;
        } else {
          entry = undefined;
        }
      }
    }

    if (entry !== undefined) normalized.push(entry);
  }

  set(out, "tools", normalized.length === 0 ? tools : normalized);
};

// --- input steps ----------------------------------------------------------------------------------------------------------

interface InputContext {
  readonly items: JsonObject[];
  inModelTurn: boolean;
  lastStepType: string;
  pendingSignature: string;
  readonly run: UserRun;
  instruction: boolean;
}

/** `userRun`: model and instruction content close the open user turn and have no tracker. */
const userRun = (ctx: InputContext, role: string): UserRun | undefined => {
  if (role === "user" && !ctx.instruction) return ctx.run;
  ctx.run.end();

  return undefined;
};

const appendGeminiTextContent = (items: JsonObject[], role: string, text: string): void => {
  items.push(interactionsGeminiContent(role, [geminiTextPartJson(text, false)]));
};

const appendText = (ctx: InputContext, role: string, text: string): void => {
  appendGeminiTextContent(ctx.items, role, text);
  const run = userRun(ctx, role);

  if (text.trim() !== "") run?.add();
};

const lastRole = (ctx: InputContext): string =>
  asString(get(ctx.items[ctx.items.length - 1], "role"));

const appendParts = (content: JsonObject, parts: Json[]): void => {
  const existing = content["parts"];
  content["parts"] = [...(isJsonArray(existing) ? existing : []), ...parts];
};

const appendToLastOrNew = (ctx: InputContext, role: string, parts: Json[]): void => {
  const last = ctx.items[ctx.items.length - 1];

  if (ctx.inModelTurn && last !== undefined && lastRole(ctx) === "model") appendParts(last, parts);
  else ctx.items.push(interactionsGeminiContent(role, parts));
};

const signatureCarrier = (signature: string): JsonObject => ({
  text: "",
  thoughtSignature: signature,
});

const flushPendingGeminiSignature = (ctx: InputContext): void => {
  if (ctx.pendingSignature === "") return;
  const carrier = signatureCarrier(ctx.pendingSignature);
  ctx.pendingSignature = "";
  const last = ctx.items[ctx.items.length - 1];

  if (last !== undefined && lastRole(ctx) === "model") appendParts(last, [carrier]);
  else ctx.items.push(interactionsGeminiContent("model", [carrier]));
};

const stepSignature = (item: Json): string =>
  firstNonEmptyString(
    asString(get(item, "signature")),
    asString(get(item, "thought_signature")),
    asString(get(item, "thoughtSignature")),
  );

const interactionsContentToParts = (content: Json | undefined, thought: boolean): Json[] => {
  if (content === undefined) return [];
  const parts: Json[] = [];

  if (isJsonArray(content)) {
    for (const part of content) {
      const converted = interactionsContentPartToGeminiPart(part, thought);

      if (converted !== undefined) parts.push(converted);
    }
  } else if (isJsonObject(content)) {
    const converted = interactionsContentPartToGeminiPart(content, thought);

    if (converted !== undefined) parts.push(converted);
  } else if (typeof content === "string") {
    parts.push(geminiTextPartJson(content, thought));
  }

  return parts;
};

const buildGeminiFunctionCallPart = (item: Json): JsonObject => {
  const functionCall: JsonObject = { name: asString(get(item, "name")), args: {} };
  const callId = get(item, "call_id");
  const id = get(item, "id");

  if (callId !== undefined) functionCall["id"] = asString(callId);
  else if (id !== undefined) functionCall["id"] = asString(id);
  const args = get(item, "arguments");

  if (args !== undefined) functionCall["args"] = args;

  return { functionCall };
};

const buildGeminiFunctionResultPart = (item: Json): Json => {
  const functionResponse: JsonObject = { name: asString(get(item, "name")), response: {} };
  const callId = get(item, "call_id");
  const id = get(item, "id");

  if (callId !== undefined) functionResponse["id"] = asString(callId);
  else if (id !== undefined) functionResponse["id"] = asString(id);
  const part: Json = { functionResponse };
  const result = get(item, "result");

  return result === undefined
    ? part
    : setGeminiFunctionResponseResult(part, "functionResponse.response", result);
};

const interactionsGeminiContentRole = (role: string, defaultRole: string): string => {
  switch (role.trim().toLowerCase()) {
    case "model":
    case "assistant":
      return "model";
    case "user":
      return "user";
    default:
      return defaultRole === "model" ? "model" : "user";
  }
};

const interactionsNativeGeminiPart = (part: Json): Json | undefined => {
  if (exists(part, "text") || exists(part, "functionCall") || exists(part, "functionResponse"))
    return part;
  const inline = get(part, "inlineData");

  if (inline !== undefined) return geminiInlineDataPartJson(inline);
  const fileData = get(part, "fileData");

  if (fileData !== undefined) return geminiFileDataPartJson(fileData);
  const snakeInline = get(part, "inline_data");

  if (snakeInline !== undefined) return geminiInlineDataPartJson(snakeInline);
  const snakeFile = get(part, "file_data");

  return snakeFile === undefined ? undefined : geminiFileDataPartJson(snakeFile);
};

const appendInteractionsNativeContent = (
  ctx: InputContext,
  item: Json,
  defaultRole: string,
): void => {
  const parts = get(item, "parts");

  if (!isJsonArray(parts)) return;
  const role = interactionsGeminiContentRole(asString(get(item, "role")), defaultRole);
  const run = userRun(ctx, role);
  const partItems: Json[] = [];

  for (const part of parts) {
    const converted = interactionsNativeGeminiPart(part);

    if (converted === undefined) {
      const dropped = interactionsAttachmentType(part);

      if (dropped !== "") run?.drop(dropped);
      continue;
    }

    partItems.push(converted);

    if (geminiPartIsSendable(converted)) run?.add();
  }

  if (partItems.length > 0) ctx.items.push(interactionsGeminiContent(role, partItems));
};

const appendInteractionsContentPart = (
  items: JsonObject[],
  role: string,
  part: Json,
  run: UserRun | undefined,
): void => {
  const converted = interactionsContentPartToGeminiPart(part, false);

  if (converted === undefined) {
    const dropped = interactionsAttachmentType(part);

    if (dropped !== "") run?.drop(dropped);

    return;
  }

  items.push(interactionsGeminiContent(role, [converted]));

  if (geminiPartIsSendable(converted)) run?.add();
};

const appendInteractionsContentList = (
  ctx: InputContext,
  role: string,
  content: Json | undefined,
): void => {
  if (content === undefined) return;
  const run = userRun(ctx, role);

  if (isJsonArray(content)) {
    for (const part of content) appendInteractionsContentPart(ctx.items, role, part, run);
  } else if (isJsonObject(content)) {
    appendInteractionsContentPart(ctx.items, role, content, run);
  } else if (typeof content === "string") {
    appendText(ctx, role, content);
  }
};

const appendStepToGemini = (ctx: InputContext, item: Json, defaultRole: string): void => {
  const inherited = ctx.instruction;
  ctx.instruction = isInteractionsInstructionStep(item, inherited);

  try {
    if (typeof item === "string") {
      if (ctx.inModelTurn) {
        flushPendingGeminiSignature(ctx);
        ctx.inModelTurn = false;
      }

      appendText(ctx, defaultRole, item);
      ctx.lastStepType = "text";

      return;
    }

    const steps = get(item, "steps");

    if (isJsonArray(steps)) {
      let role = defaultRole;
      const itemRole = asString(get(item, "role"));

      if (itemRole === "model" || itemRole === "assistant") role = "model";
      else if (itemRole === "user") role = "user";

      for (const child of steps) appendStepToGemini(ctx, child, role);

      return;
    }

    switch (asString(get(item, "type"))) {
      case "model_output": {
        ctx.run.end();

        if (ctx.pendingSignature !== "") {
          const carrier = signatureCarrier(ctx.pendingSignature);
          ctx.pendingSignature = "";
          appendToLastOrNew(ctx, "model", [carrier]);
        }

        const partItems = interactionsContentToParts(
          get(item, "content") ?? get(item, "text"),
          false,
        );

        if (partItems.length > 0) appendToLastOrNew(ctx, "model", partItems);
        ctx.inModelTurn = true;
        ctx.lastStepType = "model_output";
        break;
      }

      case "thought": {
        ctx.run.end();
        const sig = stepSignature(item);

        if (sig !== "") {
          if (ctx.pendingSignature !== "" && ctx.pendingSignature !== sig) {
            appendToLastOrNew(ctx, "model", [signatureCarrier(ctx.pendingSignature)]);
          }

          ctx.pendingSignature = sig;
        }

        const partItems = interactionsContentToParts(
          get(item, "content") ?? get(item, "summary") ?? get(item, "text"),
          true,
        );

        if (partItems.length > 0) appendToLastOrNew(ctx, "model", partItems);
        ctx.inModelTurn = true;
        ctx.lastStepType = "thought";
        break;
      }

      case "function_call": {
        ctx.run.end();
        const part = buildGeminiFunctionCallPart(item);
        let sig = stepSignature(item);

        if (sig === "" && ctx.pendingSignature !== "") {
          sig = ctx.pendingSignature;
          ctx.pendingSignature = "";
        } else if (sig !== "" && ctx.pendingSignature !== "") {
          if (ctx.pendingSignature === sig) {
            ctx.pendingSignature = "";
          } else {
            const carrier = signatureCarrier(ctx.pendingSignature);
            ctx.pendingSignature = "";
            appendToLastOrNew(ctx, "model", [carrier]);
          }
        }

        if (sig !== "") part["thoughtSignature"] = sig;
        appendToLastOrNew(ctx, "model", [part]);
        ctx.inModelTurn = true;
        ctx.lastStepType = "function_call";
        break;
      }

      case "function_result": {
        if (ctx.inModelTurn) {
          flushPendingGeminiSignature(ctx);
          ctx.inModelTurn = false;
        }

        const part = buildGeminiFunctionResultPart(item);
        // A tool result is content the model reads, so it keeps the surrounding user turn.
        ctx.run.add();
        const last = ctx.items[ctx.items.length - 1];

        if (
          ctx.lastStepType === "function_result" &&
          last !== undefined &&
          lastRole(ctx) === "user"
        ) {
          const existing = last["parts"];
          last["parts"] = reorderGeminiUserParts([
            ...(isJsonArray(existing) ? existing : []),
            part,
          ]);
        } else {
          ctx.items.push(interactionsGeminiContent("user", [part]));
        }

        ctx.lastStepType = "function_result";
        break;
      }

      case "user_input":
      case "": {
        if (ctx.inModelTurn) {
          flushPendingGeminiSignature(ctx);
          ctx.inModelTurn = false;
        }

        if (exists(item, "parts")) appendInteractionsNativeContent(ctx, item, defaultRole);
        else appendInteractionsContentList(ctx, defaultRole, get(item, "content"));
        ctx.lastStepType = "user_input";
        break;
      }

      default: {
        if (ctx.inModelTurn) {
          flushPendingGeminiSignature(ctx);
          ctx.inModelTurn = false;
        }

        if (exists(item, "parts")) appendInteractionsNativeContent(ctx, item, defaultRole);
        else if (exists(item, "content"))
          appendInteractionsContentList(ctx, defaultRole, get(item, "content"));
        else if (exists(item, "text")) appendText(ctx, defaultRole, asString(get(item, "text")));
        ctx.lastStepType = "default";
      }
    }
  } finally {
    ctx.instruction = inherited;
  }
};

/** `appendInteractionsInput`; throws the refusal for an emptied user turn. */
const appendInteractionsInput = (
  items: JsonObject[],
  input: Json | undefined,
  partial: () => Json,
): void => {
  if (input === undefined) return;

  const ctx: InputContext = {
    items,
    inModelTurn: false,
    lastStepType: "",
    pendingSignature: "",
    run: new UserRun(),
    instruction: false,
  };

  if (typeof input === "string") {
    appendGeminiTextContent(ctx.items, "user", input);

    return;
  }

  if (isJsonArray(input)) {
    for (const item of input) appendStepToGemini(ctx, item, "user");
  } else if (isJsonArray(get(input, "steps"))) {
    let defaultRole = "user";
    const role = asString(get(input, "role"));

    if (role === "model" || role === "assistant") defaultRole = "model";
    ctx.instruction = isInteractionsInstructionStep(input, false);

    // SAFETY: the enclosing `isJsonArray(get(input, "steps"))` branch condition checked that `steps` is an array.
    for (const step of get(input, "steps") as Json[]) appendStepToGemini(ctx, step, defaultRole);
    ctx.instruction = false;
  } else {
    appendStepToGemini(ctx, input, "user");
  }

  flushPendingGeminiSignature(ctx);
  ctx.run.end();
  const error = ctx.run.err(partial());

  if (error !== undefined) throw error;
};

/** `ConvertInteractionsRequestToGemini`. */
export const convertInteractionsRequestToGemini = (
  modelName: string,
  request: Json,
  _stream: boolean,
): Json => {
  const out: JsonObject = { model: "", contents: [] };

  if (modelName !== "" && exists(request, "model")) out["model"] = modelName;
  copyInteractionsSystemInstruction(out, request);
  copyInteractionsGenerationConfig(out, request);
  copyInteractionsResponseModalities(out, request);
  copyInteractionsTools(out, request);
  copyInteractionsToolChoice(out, request);
  copyInteractionsServiceTier(out, request);
  const contentItems: JsonObject[] = [];

  const finish = (): Json => {
    if (contentItems.length > 0) out["contents"] = contentItems;

    return out;
  };

  appendInteractionsInput(contentItems, get(request, "input"), finish);

  return finish();
};

/** `ConvertInteractionsRequestToInteractions`: unchanged. */
export const convertInteractionsRequestToInteractions = (
  _model: string,
  body: Json,
  _stream: boolean,
): Json => body;
