/**
 * Interactions client -> Antigravity provider (request).
 *
 * Go source: internal/translator/antigravity/interactions/interactions_antigravity_request.go. Not ported: the
 * Interactions continuation sessions of the executor (`PrepareAntigravityInteractions`).
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
import {
  geminiPartIsSendable,
  isInteractionsInstructionStep,
  interactionsAttachmentType,
  UserRun,
} from "../../common/parts.ts";
import {
  reorderGeminiUserParts,
  setGeminiFunctionResponseResult,
} from "../../gemini/common/contents.ts";
import { normalizeOpenAIFileData } from "../../common/file-data.ts";
import { attachDefaultSafetySettings } from "../../gemini/common/safety.ts";
import { mapSanitizedFunctionName, sanitizedFunctionNameMap } from "../../common/tool-names.ts";
import { deduplicateFunctionDeclarations } from "../openai/chat-request.ts";

type NameMap = ReadonlyMap<string, string> | undefined;

const firstNonEmpty = (...values: string[]): string => {
  for (const value of values) if (value.trim() !== "") return value.trim();

  return "";
};

const textPart = (text: string, thought: boolean): JsonObject =>
  thought ? { text, thought: true } : { text };

const contentOf = (role: string, parts: Json[]): JsonObject => ({ role, parts });

/** `antigravityContentRole`. */
const contentRole = (role: string, defaultRole: string): string => {
  switch (role.trim().toLowerCase()) {
    case "model":
    case "assistant":
      return "model";
    case "user":
      return "user";
  }

  return defaultRole === "model" ? "model" : "user";
};

const inlineDataPart = (inline: Json | undefined): JsonObject | undefined => {
  const mimeType = asString(get(inline, "mimeType")) || asString(get(inline, "mime_type"));
  const data = asString(get(inline, "data"));

  if (mimeType === "" || data === "") return undefined;

  return { inlineData: { mimeType, data } };
};

const fileDataPart = (fileData: Json | undefined): JsonObject | undefined => {
  const mimeType = asString(get(fileData, "mimeType")) || asString(get(fileData, "mime_type"));
  const fileUri = asString(get(fileData, "fileUri")) || asString(get(fileData, "file_uri"));

  if (mimeType === "" || fileUri === "") return undefined;

  return { fileData: { mimeType, fileUri } };
};

const inlineFromDataUrl = (dataUrl: string): JsonObject | undefined => {
  if (!dataUrl.startsWith("data:")) return undefined;
  const payload = dataUrl.slice(5);
  const semicolon = payload.indexOf(";");

  if (semicolon < 0) return undefined;
  const tail = payload.slice(semicolon + 1);

  if (!tail.startsWith("base64,")) return undefined;

  return inlineDataPart({ mime_type: payload.slice(0, semicolon), data: tail.slice(7) });
};

const inputAudioMimeType = (format: string): string => {
  switch (format.trim().toLowerCase()) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/opus";
    case "pcm16":
      return "audio/pcm";
    default:
      return "audio/mpeg";
  }
};

/** `appendInteractionsContentToAntigravityPart`. */
const contentToPart = (content: Json, thought: boolean): JsonObject | undefined => {
  const text = get(content, "text");

  if (text !== undefined) return textPart(asString(text), thought);
  const inline = get(content, "inline_data") ?? get(content, "inlineData");

  if (inline !== undefined) return inlineDataPart(inline);

  switch (asString(get(content, "type")).trim().toLowerCase()) {
    case "text":
      break;
    case "image":
    case "audio":
    case "video":
    case "document": {
      const mime = get(content, "mime_type");

      if (mime !== undefined || get(content, "mimeType") !== undefined) {
        const mimeType = asString(mime) || asString(get(content, "mimeType"));
        const data = asString(get(content, "data"));

        if (data !== "") return inlineDataPart({ mime_type: mimeType, data });
      }

      // `uri` is the Interactions spelling of file_uri.
      const fileUri = firstNonEmpty(
        asString(get(content, "file_uri")),
        asString(get(content, "fileUri")),
        asString(get(content, "uri")),
      );

      if (fileUri !== "") {
        const mimeType = asString(get(content, "mime_type")) || asString(get(content, "mimeType"));

        return fileDataPart({ mimeType, fileUri });
      }

      const url = get(content, "url");

      if (url !== undefined) return inlineFromDataUrl(asString(url));
      break;
    }

    case "image_url":
      return inlineFromDataUrl(asString(get(content, "image_url.url")));
    case "input_audio":
      return inlineDataPart({
        mime_type: inputAudioMimeType(asString(get(content, "input_audio.format"))),
        data: asString(get(content, "input_audio.data")),
      });
    case "file": {
      const file = normalizeOpenAIFileData(
        asString(get(content, "file.filename")),
        "",
        asString(get(content, "file.file_data")),
      );

      if (file !== undefined) return inlineDataPart({ mime_type: file.mimeType, data: file.data });
      break;
    }
  }

  return undefined;
};

/** `interactionsNativeAntigravityPart`. */
const nativePart = (part: Json): Json | undefined => {
  if (exists(part, "text") || exists(part, "functionCall") || exists(part, "functionResponse"))
    return part;

  if (exists(part, "inlineData")) return inlineDataPart(get(part, "inlineData"));

  if (exists(part, "fileData")) return fileDataPart(get(part, "fileData"));

  if (exists(part, "inline_data")) return inlineDataPart(get(part, "inline_data"));

  if (exists(part, "file_data")) return fileDataPart(get(part, "file_data"));

  return undefined;
};

/** `buildAntigravityFunctionCallPart`. */
const functionCallPart = (step: Json): JsonObject => {
  const call: JsonObject = { name: asString(get(step, "name")), args: {} };
  const callId = get(step, "call_id");

  if (callId !== undefined) call["id"] = asString(callId);
  else {
    const id = get(step, "id");

    if (id !== undefined) call["id"] = asString(id);
  }

  const args = get(step, "arguments");

  if (args !== undefined) call["args"] = structuredClone(args);

  return { functionCall: call };
};

/** `buildAntigravityFunctionResultPart`. */
const functionResultPart = (step: Json): JsonObject => {
  const response: JsonObject = { name: asString(get(step, "name")), response: {} };
  const callId = get(step, "call_id");

  if (callId !== undefined) response["id"] = asString(callId);
  else {
    const id = get(step, "id");

    if (id !== undefined) response["id"] = asString(id);
  }

  const part: JsonObject = { functionResponse: response };
  const result = get(step, "result");

  if (result !== undefined)
    setGeminiFunctionResponseResult(part, "functionResponse.response", structuredClone(result));

  return part;
};

const signatureOf = (step: Json): string =>
  firstNonEmpty(
    asString(get(step, "signature")),
    asString(get(step, "thought_signature")),
    asString(get(step, "thoughtSignature")),
  );

interface InputContext {
  items: JsonObject[];
  inModelTurn: boolean;
  lastStepType: string;
  pendingSignature: string;
  readonly run: UserRun;
  instruction: boolean;
}

const lastRole = (ctx: InputContext): string =>
  asString(get(ctx.items[ctx.items.length - 1], "role"));

const appendPartTo = (ctx: InputContext, part: Json): void => {
  if (ctx.inModelTurn && ctx.items.length > 0 && lastRole(ctx) === "model") {
    // SAFETY: `ctx.items` is non-empty (checked above) and every item is built by `contentOf`, so the last item is an object whose `parts` is an array.
    ((ctx.items[ctx.items.length - 1] as JsonObject)["parts"] as Json[]).push(part);
  } else ctx.items.push(contentOf("model", [part]));
};

const appendPartsTo = (ctx: InputContext, parts: Json[]): void => {
  if (ctx.inModelTurn && ctx.items.length > 0 && lastRole(ctx) === "model") {
    // SAFETY: `ctx.items` is non-empty (checked above) and every item is built by `contentOf`, so the last item is an object whose `parts` is an array.
    ((ctx.items[ctx.items.length - 1] as JsonObject)["parts"] as Json[]).push(...parts);
  } else ctx.items.push(contentOf("model", parts));
};

const flushPendingSignature = (ctx: InputContext): void => {
  if (ctx.pendingSignature === "") return;
  const carrier: JsonObject = { text: "", thoughtSignature: ctx.pendingSignature };
  ctx.pendingSignature = "";

  if (ctx.items.length > 0 && lastRole(ctx) === "model") {
    // SAFETY: `ctx.items` is non-empty (checked above) and every item is built by `contentOf`, so the last item is an object whose `parts` is an array.
    ((ctx.items[ctx.items.length - 1] as JsonObject)["parts"] as Json[]).push(carrier);
  } else ctx.items.push(contentOf("model", [carrier]));
};

/** `ctx.userRun(role)`: model and instruction content close the open user turn and have no tracker. */
const userRun = (ctx: InputContext, role: string): UserRun | undefined => {
  if (role === "user" && !ctx.instruction) return ctx.run;
  ctx.run.end();

  return undefined;
};

const appendText = (ctx: InputContext, role: string, text: string): void => {
  ctx.items.push(contentOf(contentRole(role, "user"), [textPart(text, false)]));
  const run = userRun(ctx, role);

  if (text.trim() !== "") run?.add();
};

const stepContentParts = (content: Json | undefined, thought: boolean): Json[] => {
  if (content === undefined) return [];

  if (isJsonArray(content)) {
    return content.flatMap((part) => {
      const converted = contentToPart(part, thought);

      return converted === undefined ? [] : [converted];
    });
  }

  if (isJsonObject(content)) {
    const converted = contentToPart(content, thought);

    return converted === undefined ? [] : [converted];
  }

  if (typeof content === "string") return [textPart(content, thought)];

  return [];
};

/** `extractInteractionsStepContentPartsToAntigravity`: `content`, else `text`. */
const modelOutputParts = (step: Json): Json[] =>
  stepContentParts(get(step, "content") ?? get(step, "text"), false);

/** `extractInteractionsThoughtPartsToAntigravity`: `content`, else `summary`, else `text`. */
const thoughtParts = (step: Json): Json[] =>
  stepContentParts(get(step, "content") ?? get(step, "summary") ?? get(step, "text"), true);

const appendNativeContent = (ctx: InputContext, step: Json, defaultRole: string): void => {
  const parts = get(step, "parts");

  if (!isJsonArray(parts)) return;
  const role = contentRole(asString(get(step, "role")), defaultRole);
  const run = userRun(ctx, role);
  const items: Json[] = [];

  for (const part of parts) {
    const converted = nativePart(part);

    if (converted === undefined) {
      const dropped = interactionsAttachmentType(part);

      if (dropped !== "") run?.drop(dropped);
      continue;
    }

    items.push(converted);

    if (isJsonObject(converted) && geminiPartIsSendable(converted)) run?.add();
  }

  if (items.length > 0) ctx.items.push(contentOf(role, items));
};

const appendContentPart = (
  ctx: InputContext,
  role: string,
  part: Json,
  run: UserRun | undefined,
): void => {
  const converted = contentToPart(part, false);

  if (converted === undefined) {
    const dropped = interactionsAttachmentType(part);

    if (dropped !== "") run?.drop(dropped);

    return;
  }

  ctx.items.push(contentOf(role, [converted]));

  if (geminiPartIsSendable(converted)) run?.add();
};

const appendContentList = (ctx: InputContext, role: string, content: Json | undefined): void => {
  if (content === undefined) return;
  const run = userRun(ctx, role);

  if (isJsonArray(content)) for (const part of content) appendContentPart(ctx, role, part, run);
  else if (isJsonObject(content)) appendContentPart(ctx, role, content, run);
  else if (typeof content === "string") appendText(ctx, role, content);
};

const leaveModelTurn = (ctx: InputContext): void => {
  if (ctx.inModelTurn) {
    flushPendingSignature(ctx);
    ctx.inModelTurn = false;
  }
};

/** `appendInteractionsStepToAntigravity`. */
const appendStep = (ctx: InputContext, step: Json, defaultRole: string): void => {
  const inheritedInstruction = ctx.instruction;
  ctx.instruction = isInteractionsInstructionStep(step, inheritedInstruction);

  try {
    if (typeof step === "string") {
      leaveModelTurn(ctx);
      appendText(ctx, defaultRole, step);
      ctx.lastStepType = "text";

      return;
    }

    const steps = get(step, "steps");

    if (isJsonArray(steps)) {
      let role = defaultRole;
      const itemRole = asString(get(step, "role"));

      if (itemRole === "model" || itemRole === "assistant") role = "model";
      else if (itemRole === "user") role = "user";

      for (const child of steps) appendStep(ctx, child, role);

      return;
    }

    switch (asString(get(step, "type"))) {
      case "model_output": {
        ctx.run.end();

        if (ctx.pendingSignature !== "") {
          const carrier: JsonObject = { text: "", thoughtSignature: ctx.pendingSignature };
          ctx.pendingSignature = "";
          appendPartTo(ctx, carrier);
        }

        const parts = modelOutputParts(step);

        if (parts.length > 0) appendPartsTo(ctx, parts);
        ctx.inModelTurn = true;
        ctx.lastStepType = "model_output";

        return;
      }

      case "thought": {
        ctx.run.end();
        const sig = signatureOf(step);

        if (sig !== "") {
          if (ctx.pendingSignature !== "" && ctx.pendingSignature !== sig) {
            appendPartTo(ctx, { text: "", thoughtSignature: ctx.pendingSignature });
          }

          ctx.pendingSignature = sig;
        }

        const parts = thoughtParts(step);

        if (parts.length > 0) appendPartsTo(ctx, parts);
        ctx.inModelTurn = true;
        ctx.lastStepType = "thought";

        return;
      }

      case "function_call": {
        ctx.run.end();
        const part = functionCallPart(step);
        let sig = signatureOf(step);

        if (sig === "" && ctx.pendingSignature !== "") {
          sig = ctx.pendingSignature;
          ctx.pendingSignature = "";
        } else if (sig !== "" && ctx.pendingSignature !== "") {
          if (ctx.pendingSignature === sig) ctx.pendingSignature = "";
          else {
            const carrier: JsonObject = { text: "", thoughtSignature: ctx.pendingSignature };
            ctx.pendingSignature = "";
            appendPartTo(ctx, carrier);
          }
        }

        if (sig !== "") part["thoughtSignature"] = sig;
        appendPartTo(ctx, part);
        ctx.inModelTurn = true;
        ctx.lastStepType = "function_call";

        return;
      }

      case "function_result": {
        leaveModelTurn(ctx);
        const part = functionResultPart(step);
        // A tool result is content the model reads, so it keeps the surrounding user turn.
        ctx.run.add();

        if (
          ctx.lastStepType === "function_result" &&
          ctx.items.length > 0 &&
          lastRole(ctx) === "user"
        ) {
          // SAFETY: `ctx.items.length > 0` was checked above, so the last item exists.
          const target = ctx.items[ctx.items.length - 1] as JsonObject;
          // SAFETY: items are built by `contentOf`, so `target.parts` is an array.
          target["parts"] = reorderGeminiUserParts([...(target["parts"] as Json[]), part]);
        } else ctx.items.push(contentOf("user", [part]));
        ctx.lastStepType = "function_result";

        return;
      }

      case "user_input":
      case "": {
        leaveModelTurn(ctx);

        if (exists(step, "parts")) appendNativeContent(ctx, step, defaultRole);
        else appendContentList(ctx, defaultRole, get(step, "content"));
        ctx.lastStepType = "user_input";

        return;
      }

      default: {
        leaveModelTurn(ctx);

        if (exists(step, "parts")) appendNativeContent(ctx, step, defaultRole);
        else if (exists(step, "content")) appendContentList(ctx, defaultRole, get(step, "content"));
        else {
          const text = get(step, "text");

          if (text !== undefined) appendText(ctx, defaultRole, asString(text));
        }

        ctx.lastStepType = "default";
      }
    }
  } finally {
    ctx.instruction = inheritedInstruction;
  }
};

/**
 * `appendInteractionsContentBlockItem` (upstream 37bd18b0): input as a bare list of content blocks, which have no step
 * envelope and would otherwise be dropped (images and files with them). Envelope and explicit-role items keep the step
 * dispatch, so system/developer content still closes the open user turn.
 */
const appendContentBlockItem = (ctx: InputContext, item: Json): boolean => {
  switch (asString(get(item, "type")).trim().toLowerCase()) {
    case "text":
    case "image":
    case "audio":
    case "video":
    case "document":
      break;
    default:
      return false;
  }

  if (
    get(item, "content") !== undefined ||
    get(item, "steps") !== undefined ||
    get(item, "parts") !== undefined ||
    get(item, "role") !== undefined
  ) {
    return false;
  }

  leaveModelTurn(ctx);
  appendContentPart(ctx, "user", item, userRun(ctx, "user"));
  ctx.lastStepType = "user_input";

  return true;
};

type ConvertInputResult = { items: JsonObject[]; run: UserRun };

/** `appendInteractionsInputToAntigravity`: the conversation items and the unsupported-part tracker. */
const convertInput = (input: Json | undefined): ConvertInputResult => {
  const ctx: InputContext = {
    items: [],
    inModelTurn: false,
    lastStepType: "",
    pendingSignature: "",
    run: new UserRun(),
    instruction: false,
  };

  if (input === undefined) return { items: ctx.items, run: ctx.run };

  if (typeof input === "string") {
    ctx.items.push(contentOf("user", [textPart(input, false)]));

    return { items: ctx.items, run: ctx.run };
  }

  if (isJsonArray(input)) {
    for (const item of input) {
      if (!appendContentBlockItem(ctx, item)) appendStep(ctx, item, "user");
    }
  } else if (isJsonArray(get(input, "steps"))) {
    const role = asString(get(input, "role"));
    const defaultRole = role === "model" || role === "assistant" ? "model" : "user";
    ctx.instruction = isInteractionsInstructionStep(input, false);

    // SAFETY: the enclosing `isJsonArray(get(input, "steps"))` branch condition checked that `steps` is an array.
    for (const step of get(input, "steps") as Json[]) appendStep(ctx, step, defaultRole);
    ctx.instruction = false;
  } else {
    appendStep(ctx, input, "user");
  }

  flushPendingSignature(ctx);
  ctx.run.end();

  return { items: ctx.items, run: ctx.run };
};

// --- tools ------------------------------------------------------------------------------------------------------------

/** `antigravityFunctionDeclarationJSON`. */
const functionDeclaration = (decl: Json, nameMap: NameMap): JsonObject | undefined => {
  const nested = get(decl, "function");
  const fn = isJsonObject(nested) ? nested : decl;
  const name = asString(get(fn, "name"));

  if (name.trim() === "") return undefined;

  const out: JsonObject = {
    name: mapSanitizedFunctionName(nameMap, name),
    parametersJsonSchema: { type: "object", properties: {} },
  };

  const description = get(fn, "description");

  if (description !== undefined) out["description"] = asString(description);
  const parameters = get(fn, "parametersJsonSchema") ?? get(fn, "parameters");

  if (parameters !== undefined) out["parametersJsonSchema"] = structuredClone(parameters);
  const response = get(fn, "response");

  if (response !== undefined) out["response"] = structuredClone(response);
  const responseSchema = get(fn, "responseJsonSchema");

  if (responseSchema !== undefined) out["responseJsonSchema"] = structuredClone(responseSchema);

  return out;
};

const objectOrEmpty = (value: Json | undefined): Json =>
  isJsonObject(value) ? structuredClone(value) : {};

const copyTools = (out: Json, root: Json, nameMap: NameMap): void => {
  if (get(out, "request.toolConfig.functionCallingConfig.mode") === "NONE") {
    del(out, "request.tools");

    return;
  }

  const tools = get(root, "tools");

  if (tools === undefined) return;

  if (!isJsonArray(tools)) {
    set(out, "request.tools", structuredClone(tools));

    return;
  }

  const declarations: Json[] = [];
  const otherTools: Json[] = [];

  for (const tool of tools) {
    let handled = false;

    for (const key of ["functionDeclarations", "function_declarations"]) {
      const decls = get(tool, key);

      if (isJsonArray(decls)) {
        for (const decl of decls) {
          const converted = functionDeclaration(decl, nameMap);

          if (converted !== undefined) declarations.push(converted);
        }

        handled = true;
        break;
      }
    }

    if (handled) continue;

    if (asString(get(tool, "type")) === "function" || exists(tool, "name")) {
      const converted = functionDeclaration(tool, nameMap);

      if (converted !== undefined) declarations.push(converted);
      continue;
    }

    const toolType = asString(get(tool, "type"));

    switch (toolType) {
      case "url_context":
        otherTools.push({
          urlContext: objectOrEmpty(get(tool, "url_context") ?? get(tool, "urlContext")),
        });
        continue;
      case "code_execution":
        otherTools.push({
          codeExecution: objectOrEmpty(get(tool, "code_execution") ?? get(tool, "codeExecution")),
        });
        continue;
      case "google_search":
      case "web_search":
        otherTools.push({
          googleSearch: objectOrEmpty(get(tool, "google_search") ?? get(tool, "googleSearch")),
        });
        continue;
    }

    const raw: Json = structuredClone(tool);

    if (toolType === "") {
      for (const [from, to] of [
        ["url_context", "urlContext"],
        ["code_execution", "codeExecution"],
        ["google_search", "googleSearch"],
        ["web_search", "googleSearch"],
      ] as const) {
        const value = get(tool, from);

        if (value !== undefined) {
          set(raw, to, structuredClone(value));
          del(raw, from);
        }
      }
    }

    otherTools.push(raw);
  }

  const deduplicated = deduplicateFunctionDeclarations(declarations);

  if (deduplicated.length > 0 || otherTools.length > 0) {
    const items: Json[] = [];

    if (deduplicated.length > 0) items.push({ functionDeclarations: deduplicated });
    items.push(...otherTools);
    set(out, "request.tools", items);
  }
};

// --- generation config ------------------------------------------------------------------------------------------------

const toCamelCase = (key: string): string => {
  const parts = key.split("_");
  // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
  let out = parts[0] as string;

  for (const part of parts.slice(1))
    if (part !== "") out += part.slice(0, 1).toUpperCase() + part.slice(1);

  return out;
};

/** `convertSnakeCaseKeysToCamelCaseForAntigravity`: empty objects and arrays vanish, like the path-based Go copy. */
const camelCaseKeys = (node: Json): Json | undefined => {
  if (isJsonObject(node)) {
    const out: JsonObject = {};

    for (const [key, value] of Object.entries(node)) {
      const converted = camelCaseKeys(value);

      if (converted !== undefined) out[toCamelCase(key)] = converted;
    }

    return Object.keys(out).length === 0 ? undefined : out;
  }

  if (isJsonArray(node)) {
    const out = node.flatMap((value) => {
      const converted = camelCaseKeys(value);

      return converted === undefined ? [] : [converted];
    });

    return out.length === 0 ? undefined : out;
  }

  return node;
};

/** `antigravityThinkingSummariesIncludeThoughts`. */
const summariesIncludeThoughts = (summary: Json | undefined): boolean | undefined => {
  if (typeof summary !== "string") return undefined;

  switch (summary.trim().toLowerCase()) {
    case "auto":
      return true;
    case "none":
      return false;
  }

  return undefined;
};

const normalizeGenerationConfig = (out: Json): void => {
  const base = "request.generationConfig";

  for (const [from, to] of [
    ["thinkingLevel", "thinkingConfig.thinkingLevel"],
    ["thinkingBudget", "thinkingConfig.thinkingBudget"],
    ["includeThoughts", "thinkingConfig.includeThoughts"],
  ] as const) {
    const value = get(out, `${base}.${from}`);

    if (value !== undefined) {
      set(out, `${base}.${to}`, value);
      del(out, `${base}.${from}`);
    }
  }

  const summaries = get(out, `${base}.thinkingSummaries`);

  if (summaries !== undefined) {
    const include = summariesIncludeThoughts(summaries);

    if (include !== undefined) set(out, `${base}.thinkingConfig.includeThoughts`, include);
    del(out, `${base}.thinkingSummaries`);
  }

  if (exists(out, `${base}.toolChoice`)) del(out, `${base}.toolChoice`);
};

const copyReasoning = (out: Json, root: Json): void => {
  const reasoning = get(root, "reasoning");

  if (reasoning === undefined) return;
  let effort = asString(get(reasoning, "effort")).trim().toLowerCase();

  if (effort === "") effort = asString(get(reasoning, "thinking_level")).trim().toLowerCase();

  if (effort !== "") {
    if (effort === "auto") set(out, "request.generationConfig.thinkingConfig.thinkingBudget", -1);
    else set(out, "request.generationConfig.thinkingConfig.thinkingLevel", effort);
  }

  const summary = get(reasoning, "summary");

  if (summary !== undefined) {
    const include = summariesIncludeThoughts(summary);

    if (include !== undefined)
      set(out, "request.generationConfig.thinkingConfig.includeThoughts", include);
  }
};

const copyResponseModalities = (out: Json, root: Json): void => {
  const mods = get(root, "response_modalities") ?? get(root, "responseModalities");

  if (!isJsonArray(mods)) return;
  const result: string[] = [];

  for (const mod of mods) {
    switch (asString(mod).trim().toLowerCase()) {
      case "text":
        result.push("TEXT");
        break;
      case "image":
        result.push("IMAGE");
        break;
      case "audio":
        result.push("AUDIO");
        break;
    }
  }

  if (result.length > 0) set(out, "request.generationConfig.responseModalities", result);
};

const copyToolChoice = (out: Json, root: Json): void => {
  const toolChoice =
    get(root, "tool_choice") ??
    get(root, "generation_config.tool_choice") ??
    get(root, "generationConfig.toolChoice");

  if (toolChoice === undefined) return;
  let mode = "";
  const allowed: string[] = [];

  if (typeof toolChoice === "string") {
    switch (toolChoice.trim().toLowerCase()) {
      case "none":
        mode = "NONE";
        break;
      case "auto":
        mode = "AUTO";
        break;
      case "required":
      case "any":
        mode = "ANY";
        break;
    }
  } else if (isJsonObject(toolChoice)) {
    switch (asString(toolChoice["type"]).trim().toLowerCase()) {
      case "none":
        mode = "NONE";
        break;
      case "auto":
        mode = "AUTO";
        break;
      case "required":
      case "any":
        mode = "ANY";
        break;
      case "function": {
        mode = "ANY";
        const name = asString(get(toolChoice, "function.name"));

        if (name.trim() !== "") allowed.push(name);
        break;
      }

      case "tool": {
        mode = "ANY";
        const name = asString(toolChoice["name"]);

        if (name.trim() !== "") allowed.push(name);
        break;
      }
    }
  }

  if (mode === "") return;
  set(out, "request.toolConfig.functionCallingConfig.mode", mode);

  if (allowed.length > 0)
    set(out, "request.toolConfig.functionCallingConfig.allowedFunctionNames", allowed);
};

const copySystem = (out: Json, root: Json): void => {
  const sys = get(root, "system_instruction");

  if (sys === undefined) return;

  if (typeof sys === "string") {
    set(out, "request.systemInstruction", { parts: [{ text: sys }] });

    return;
  }

  const text = get(sys, "text");

  if (text !== undefined && !exists(sys, "parts")) {
    set(out, "request.systemInstruction", { parts: [{ text: asString(text) }] });

    return;
  }

  set(out, "request.systemInstruction", structuredClone(sys));
};

const copyGenerationConfig = (out: Json, root: Json): void => {
  const snake = get(root, "generation_config");

  if (snake !== undefined) {
    // An all-empty config produces `{}` (the Go path copy starts from an empty object).
    set(out, "request.generationConfig", camelCaseKeys(snake) ?? {});
  } else {
    const camel = get(root, "generationConfig");

    if (camel !== undefined) set(out, "request.generationConfig", structuredClone(camel));
  }

  normalizeGenerationConfig(out);
  copyReasoning(out, root);
  copyResponseModalities(out, root);
  copyToolChoice(out, root);
};

const rewriteFunctionNames = (out: Json, nameMap: NameMap): void => {
  const contents = get(out, "request.contents");

  if (isJsonArray(contents)) {
    for (const content of contents) {
      const parts = get(content, "parts");

      if (!isJsonArray(parts)) continue;

      for (const part of parts) {
        for (const field of ["functionCall", "functionResponse"]) {
          const nameResult = get(part, `${field}.name`);
          const name = asString(nameResult);

          if (name === "") continue;
          const mapped = mapSanitizedFunctionName(nameMap, name);

          if (typeof nameResult === "string" && mapped === name) continue;
          set(part, `${field}.name`, mapped);
        }
      }
    }
  }

  const path = "request.toolConfig.functionCallingConfig.allowedFunctionNames";
  const allowed = get(out, path);

  if (!isJsonArray(allowed)) return;
  let changed = false;

  const mappedNames = allowed.map((name) => {
    const mapped = mapSanitizedFunctionName(nameMap, asString(name));
    changed = changed || typeof name !== "string" || mapped !== name;

    return mapped;
  });

  if (changed) set(out, path, mappedNames);
};

/** `ConvertInteractionsRequestToAntigravity`. */
export const convertInteractionsRequestToAntigravity = (
  modelName: string,
  root: Json,
  stream: boolean,
): Json => {
  const nameMap = sanitizedFunctionNameMap(root);
  const out: Json = { project: "", request: { contents: [] }, model: modelName };

  if (stream || asBool(get(root, "stream"))) set(out, "request.stream", true);
  copySystem(out, root);
  copyGenerationConfig(out, root);
  const { items, run } = convertInput(get(root, "input"));
  set(out, "request.contents", items);
  copyTools(out, root, nameMap);

  if (get(out, "request.toolConfig.functionCallingConfig.mode") === "NONE")
    del(out, "request.tools");
  rewriteFunctionNames(out, nameMap);
  attachDefaultSafetySettings(out, "request.safetySettings");
  const refusal = run.err(out);

  if (refusal !== undefined) throw refusal;

  return out;
};
