/**
 * Interactions request -> Codex (Responses) request.
 *
 * Go source: internal/translator/codex/interactions/interactions_codex_request.go
 * (ConvertInteractionsRequestToCodex and helpers). Go copies the `generation_config` scalars in random map order;
 * the declaration order below is used instead.
 */
import {
  asBool,
  asInt,
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import { convertBudgetToLevel } from "../../../thinking/convert.ts";
import {
  codexReplaySignatureForTarget,
  resolveCodexReplayTargetModel,
} from "../../common/codex-replay-signature.ts";
import {
  interactionsAttachmentType,
  isInteractionsInstructionStep,
  UserRun,
} from "../../common/parts.ts";
import { shortenNameIfNeeded } from "../claude/request.ts";

const GENERATION_COPY_PATHS: ReadonlyArray<readonly [string, string]> = [
  ["max_output_tokens", "max_output_tokens"],
  ["maxOutputTokens", "max_output_tokens"],
  ["max_tokens", "max_output_tokens"],
  ["temperature", "temperature"],
  ["top_p", "top_p"],
  ["topP", "top_p"],
  ["presence_penalty", "presence_penalty"],
  ["presencePenalty", "presence_penalty"],
  ["frequency_penalty", "frequency_penalty"],
  ["frequencyPenalty", "frequency_penalty"],
  ["parallel_tool_calls", "parallel_tool_calls"],
  ["parallelToolCalls", "parallel_tool_calls"],
  ["response_format", "response_format"],
  ["responseFormat", "response_format"],
  ["text", "text"],
  ["verbosity", "text.verbosity"],
  ["truncation", "truncation"],
  ["tool_choice", "tool_choice"],
  ["toolChoice", "tool_choice"],
  ["service_tier", "service_tier"],
  ["serviceTier", "service_tier"],
];

const codexInputAudioFormatFromMime = (mimeType: string): string => {
  switch (mimeType.trim().toLowerCase()) {
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/flac":
      return "flac";
    case "audio/opus":
    case "audio/ogg":
      return "opus";
    case "audio/pcm":
    case "audio/l16":
      return "pcm16";
    default:
      return "mp3";
  }
};

const codexFileNameFromMime = (mimeType: string): string => {
  const mime = mimeType.trim().toLowerCase();

  switch (mime) {
    case "application/pdf":
      return "document.pdf";
    case "text/plain":
      return "document.txt";
    case "text/csv":
      return "document.csv";
    case "application/json":
      return "document.json";
    case "application/xml":
    case "text/xml":
      return "document.xml";
    default:
      return mime.startsWith("video/") ? "video" : "document";
  }
};

/** `firstNonBlankString`: the first trimmed non-empty string found at `paths`. */
const firstNonBlankString = (root: Json | undefined, ...paths: string[]): string => {
  for (const path of paths) {
    const value = asString(get(root, path)).trim();

    if (value !== "") return value;
  }

  return "";
};

/** `firstString`: the string value of the first path that exists (even when empty). */
const firstString = (root: Json | undefined, ...paths: string[]): string => {
  for (const path of paths) {
    const value = get(root, path);

    if (value !== undefined) return asString(value);
  }

  return "";
};

const reasoningEffort = (cfg: Json): string => {
  for (const path of [
    "thinking_level",
    "thinkingLevel",
    "thinking_config.thinking_level",
    "thinking_config.thinkingLevel",
    "thinkingConfig.thinking_level",
    "thinkingConfig.thinkingLevel",
    "reasoning.effort",
  ]) {
    const value = get(cfg, path);

    if (value !== undefined) {
      const effort = asString(value).trim().toLowerCase();

      if (effort !== "") return effort;
    }
  }

  for (const path of [
    "thinking_budget",
    "thinkingBudget",
    "thinking_config.thinking_budget",
    "thinking_config.thinkingBudget",
    "thinkingConfig.thinking_budget",
    "thinkingConfig.thinkingBudget",
  ]) {
    const value = get(cfg, path);

    if (value !== undefined) {
      const effort = convertBudgetToLevel(asInt(value));

      if (effort !== undefined) return effort;
    }
  }

  return "";
};

const reasoningSummary = (cfg: Json): string => {
  for (const path of ["thinking_summaries", "thinkingSummaries", "reasoning.summary"]) {
    const value = get(cfg, path);

    if (typeof value === "string") {
      const summary = value.trim().toLowerCase();

      if (summary === "auto" || summary === "none") return summary;
    }
  }

  for (const path of [
    "include_thoughts",
    "includeThoughts",
    "thinking_config.include_thoughts",
    "thinking_config.includeThoughts",
    "thinkingConfig.include_thoughts",
    "thinkingConfig.includeThoughts",
  ]) {
    const value = get(cfg, path);

    if (value === true) return "auto";

    if (value === false) return "none";
  }

  return "";
};

const copySystem = (out: Json, root: Json): Json => {
  let system = get(root, "system_instruction");

  if (system === undefined) system = get(root, "systemInstruction");

  if (system === undefined) return out;

  if (typeof system === "string") return set(out, "instructions", system);
  const text = get(system, "text");

  if (typeof text === "string") return set(out, "instructions", text);
  const parts = get(system, "parts");

  if (isJsonArray(parts)) {
    const lines: string[] = [];

    for (const part of parts) {
      const value = asString(get(part, "text"));

      if (value !== "") lines.push(value);
    }

    if (lines.length > 0) return set(out, "instructions", lines.join("\n"));
  }

  return out;
};

const copyGenerationConfig = (out: Json, root: Json): Json => {
  let cfg = get(root, "generation_config");

  if (cfg === undefined) cfg = get(root, "generationConfig");

  if (cfg === undefined) {
    const reasoning = get(root, "reasoning");

    return reasoning !== undefined ? set(out, "reasoning", cloneJson(reasoning)) : out;
  }

  const reasoning = get(cfg, "reasoning");

  if (reasoning !== undefined) out = set(out, "reasoning", cloneJson(reasoning));
  const effort = reasoningEffort(cfg);

  if (effort !== "") out = set(out, "reasoning.effort", effort);
  const summary = reasoningSummary(cfg);

  if (summary !== "") out = set(out, "reasoning.summary", summary);

  for (const [source, target] of GENERATION_COPY_PATHS) {
    const value = get(cfg, source);

    if (value !== undefined) out = set(out, target, cloneJson(value));
  }

  return out;
};

const stepRole = (step: Json | undefined, inherited: string): string => {
  if (isInteractionsInstructionStep(step, inherited === "developer")) return "developer";

  return defaultRole(asString(get(step, "role")), inherited);
};

const defaultRole = (role: string, fallback: string): string => {
  switch (role.trim().toLowerCase()) {
    case "model":
    case "assistant":
      return "assistant";
    case "developer":
    case "system":
      return "developer";
    case "user":
      return "user";
  }

  return fallback === "assistant" || fallback === "developer" ? fallback : "user";
};

const messagePart = (items: Json[], role: string, part: Json): void => {
  items.push({ type: "message", role, content: [part] });
};

const appendText = (items: Json[], role: string, text: string): void =>
  messagePart(items, role, { type: role === "assistant" ? "output_text" : "input_text", text });

/** `interactionsCodexUserRun`: the tracker for user content; other roles close the open user turn. */
const userRunFor = (run: UserRun, role: string): UserRun | undefined => {
  if (role === "user") return run;
  run.end();

  return undefined;
};

const appendRoleText = (items: Json[], role: string, text: string, run: UserRun): void => {
  appendText(items, role, text);
  const userRun = userRunFor(run, role);

  if (text.trim() !== "") userRun?.add();
};

const imagePart = (part: Json): JsonObject | undefined => {
  const imageUrl = firstNonBlankString(part, "url", "file_uri", "fileUri", "uri");

  if (imageUrl !== "") return { type: "input_image", image_url: imageUrl };
  const mimeType = firstString(part, "mime_type", "mimeType");
  const data = asString(get(part, "data"));

  if (mimeType === "" || data === "") return undefined;

  return { type: "input_image", image_url: `data:${mimeType};base64,${data}` };
};

const audioPart = (part: Json): JsonObject | undefined => {
  const mimeType = firstString(part, "mime_type", "mimeType");
  const data = asString(get(part, "data"));

  if (mimeType === "" || data === "") return undefined;

  return {
    type: "input_audio",
    input_audio: { data, format: codexInputAudioFormatFromMime(mimeType) },
  };
};

const filePart = (part: Json): JsonObject | undefined => {
  const fileData = asString(get(part, "file.file_data"));

  if (fileData !== "")
    return {
      type: "input_file",
      file_data: fileData,
      filename: asString(get(part, "file.filename")),
    };
  const mimeType = firstString(part, "mime_type", "mimeType");
  const fileUri = firstNonBlankString(part, "file_uri", "fileUri", "uri", "url");

  if (fileUri !== "")
    return { type: "input_file", file_url: fileUri, filename: codexFileNameFromMime(mimeType) };
  const data = asString(get(part, "data"));

  if (mimeType === "" || data === "") return undefined;

  return { type: "input_file", file_data: data, filename: codexFileNameFromMime(mimeType) };
};

const inlinePart = (inline: Json): JsonObject | undefined => {
  const mimeType = firstString(inline, "mime_type", "mimeType");
  const data = asString(get(inline, "data"));

  if (mimeType === "" || data === "") return undefined;
  const normalized: Json = { mime_type: mimeType, data };
  const lower = mimeType.toLowerCase();

  if (lower.startsWith("image/")) return imagePart(normalized);

  if (lower.startsWith("audio/")) return audioPart(normalized);

  return filePart(normalized);
};

const fileDataPart = (fileData: Json): JsonObject | undefined => {
  const mimeType = firstString(fileData, "mime_type", "mimeType");
  const fileUri = firstString(fileData, "file_uri", "fileUri");

  if (fileUri === "") return undefined;

  if (mimeType.toLowerCase().startsWith("image/"))
    return { type: "input_image", image_url: fileUri };

  return { type: "input_file", file_url: fileUri, filename: codexFileNameFromMime(mimeType) };
};

const codexMessagePart = (part: Json, role: string): JsonObject | undefined => {
  const text = get(part, "text");

  if (text !== undefined)
    return { type: role === "assistant" ? "output_text" : "input_text", text: asString(text) };

  switch (asString(get(part, "type")).trim().toLowerCase()) {
    case "text":
    case "":
      return undefined;
    case "image":
      return imagePart(part);
    case "image_url":
      return { type: "input_image", image_url: asString(get(part, "image_url.url")) };
    case "audio":
      return audioPart(part);
    case "input_audio": {
      const item: JsonObject = { type: "input_audio", input_audio: {} };
      const audio = get(part, "input_audio");

      if (audio !== undefined) item["input_audio"] = cloneJson(audio);

      return item;
    }

    case "video":
    case "document":
    case "file":
      return filePart(part);
    default: {
      const inline = get(part, "inline_data") ?? get(part, "inlineData");

      if (inline !== undefined) return inlinePart(inline);
      const file = get(part, "file_data") ?? get(part, "fileData");

      if (file !== undefined) return fileDataPart(file);
    }
  }

  return undefined;
};

const isBlankText = (item: JsonObject): boolean => {
  const type = asString(item["type"]);

  return (type === "input_text" || type === "output_text") && asString(item["text"]).trim() === "";
};

const appendContentPart = (
  items: Json[],
  part: Json,
  role: string,
  run: UserRun | undefined,
): void => {
  const item = codexMessagePart(part, role);

  if (item === undefined) {
    const dropped = interactionsAttachmentType(part);

    if (dropped !== "") run?.drop(dropped);

    return;
  }

  messagePart(items, role, item);

  if (!isBlankText(item)) run?.add();
};

const appendContent = (
  items: Json[],
  content: Json | undefined,
  role: string,
  run: UserRun,
): void => {
  if (content === undefined) return;

  if (typeof content === "string") {
    appendRoleText(items, role, content, run);

    return;
  }

  const userRun = userRunFor(run, role);

  if (isJsonArray(content)) {
    for (const part of content) appendContentPart(items, part, role, userRun);

    return;
  }

  if (isJsonObject(content)) appendContentPart(items, content, role, userRun);
};

const callId = (step: Json): string => {
  const id = asString(get(step, "call_id")).trim();

  return id !== "" ? id : asString(get(step, "id")).trim();
};

const jsonString = (value: Json | undefined): string =>
  typeof value === "string" ? value : value !== undefined ? JSON.stringify(value) : "{}";

const outputString = (value: Json | undefined): string =>
  typeof value === "string" ? value : value !== undefined ? JSON.stringify(value) : "";

const contentText = (content: Json | undefined): string => {
  if (content === undefined) return "";

  if (typeof content === "string") return content;

  if (isJsonObject(content)) return asString(get(content, "text"));

  if (isJsonArray(content)) {
    return content
      .map((part) => asString(get(part, "text")))
      .filter((text) => text !== "")
      .join("\n");
  }

  return "";
};

/** What a thought step needs to be restored as a reasoning item: the signature family's target and the dedup set. */
interface ThoughtTarget {
  readonly model: string;
  /** Normalised signatures already written as `encrypted_content` in this request: a repeated echo replays once. */
  readonly emitted: Set<string>;
}

/** `interactionsThoughtStepSignature`: a thought step's signature under any spelling seen on the wire. */
const thoughtStepSignature = (step: Json): string => {
  for (const path of ["signature", "thought_signature", "thoughtSignature"]) {
    const signature = asString(get(step, path)).trim();

    if (signature !== "") return signature;
  }

  return "";
};

/**
 * `appendInteractionsThoughtToCodex`: a client-echoed signature that `codexReplaySignatureForTarget` accepts for the
 * target model is restored as a Responses reasoning `encrypted_content`, with the thought text as its summary. The step
 * id is not copied: replay is stateless and the executor strips orphan ids. Every other thought step is dropped: a
 * reasoning item without accepted encrypted_content carries nothing replayable, and the legacy text shape is rejected by
 * the native Meta upstream (no summary) and by routers (content must be an array).
 */
const appendThought = (items: Json[], step: Json, target: ThoughtTarget): void => {
  let text = contentText(get(step, "content"));

  if (text === "") text = asString(get(step, "text"));
  const raw = thoughtStepSignature(step);

  if (raw === "") return;
  const normalized = codexReplaySignatureForTarget(target.model, raw);

  if (normalized === undefined || target.emitted.has(normalized)) return;
  target.emitted.add(normalized);
  const item: JsonObject = { type: "reasoning", encrypted_content: normalized, summary: [] };

  if (text !== "") item["summary"] = [{ type: "summary_text", text }];
  items.push(item);
};

const appendStep = (
  items: Json[],
  step: Json,
  role: string,
  run: UserRun,
  target: ThoughtTarget,
): void => {
  if (typeof step === "string") {
    appendRoleText(items, role, step, run);

    return;
  }

  const nested = get(step, "steps");

  if (isJsonArray(nested)) {
    const nestedRole = stepRole(step, role);

    for (const child of nested) appendStep(items, child, nestedRole, run, target);

    return;
  }

  const stepType = asString(get(step, "type")).trim().toLowerCase();

  switch (stepType) {
    case "function_call": {
      run.end();
      const item: JsonObject = { type: "function_call" };
      const name = get(step, "name");

      if (name !== undefined) item["name"] = shortenNameIfNeeded(asString(name));
      const id = callId(step);

      if (id !== "") item["call_id"] = id;
      const args = get(step, "arguments") ?? get(step, "args");

      if (args !== undefined) item["arguments"] = jsonString(args);
      items.push(item);

      return;
    }

    case "function_result":
    case "function_call_output": {
      // A tool result is content the model reads, so it keeps the surrounding user turn.
      run.add();
      const item: JsonObject = { type: "function_call_output" };
      const id = callId(step);

      if (id !== "") item["call_id"] = id;
      const result = get(step, "result");

      if (result !== undefined) item["output"] = outputString(result);
      else {
        const output = get(step, "output");

        if (output !== undefined) item["output"] = outputString(output);
      }

      items.push(item);

      return;
    }

    case "model_output":
    case "assistant":
      run.end();
      appendContent(items, get(step, "content"), "assistant", run);

      return;
    case "thought":
    case "reasoning": {
      run.end();
      appendThought(items, step, target);

      return;
    }

    default: {
      const stepRoleValue = stepRole(step, role);
      const content = get(step, "content");

      if (content !== undefined) appendContent(items, content, stepRoleValue, run);
      else {
        const text = get(step, "text");

        if (text !== undefined) appendRoleText(items, stepRoleValue, asString(text), run);
      }
    }
  }
};

/** `appendInteractionsInputToCodex`: returns the refusal for an emptied user turn, if any. */
const appendInput = (
  items: Json[],
  input: Json | undefined,
  signatureTargetModel: string,
): UserRun | undefined => {
  if (input === undefined) return undefined;

  if (typeof input === "string") {
    appendText(items, "user", input);

    return undefined;
  }

  const run = new UserRun();
  const target: ThoughtTarget = { model: signatureTargetModel, emitted: new Set() };

  if (isJsonArray(input)) {
    for (const step of input) appendStep(items, step, "user", run, target);
  } else if (isJsonArray(get(input, "steps"))) {
    const role = stepRole(input, "user");
    const steps = get(input, "steps");

    for (const step of isJsonArray(steps) ? steps : []) appendStep(items, step, role, run, target);
  } else {
    appendStep(items, input, "user", run, target);
  }

  run.end();

  return run;
};

const cleanedToolParameters = (params: Json): Json => {
  const cleaned = cloneJson(params);

  if (!isJsonObject(cleaned)) return cleaned;

  if (get(params, "$schema") !== undefined) delete cleaned["$schema"];

  if (cleaned["additionalProperties"] !== false) cleaned["additionalProperties"] = false;

  return cleaned;
};

/** `codexToolFromDeclaration`. */
const toolFromDeclaration = (declaration: Json): JsonObject => {
  const tool: JsonObject = {};
  const description = get(declaration, "description");

  if (description !== undefined) tool["description"] = asString(description);
  tool["name"] = shortenNameIfNeeded(asString(get(declaration, "name")));

  const params =
    get(declaration, "parameters") ??
    get(declaration, "parametersJsonSchema") ??
    get(declaration, "parameters_json_schema");

  if (params !== undefined) tool["parameters"] = cleanedToolParameters(params);
  tool["strict"] = false;
  tool["type"] = "function";

  return tool;
};

const copyTools = (out: Json, root: Json): Json => {
  const tools = get(root, "tools");

  if (tools === undefined) return out;

  if (!isJsonArray(tools)) return set(out, "tools", cloneJson(tools));
  const normalized: Json[] = [];

  const appendDeclarations = (declarations: Json) => {
    if (!isJsonArray(declarations)) return;

    for (const declaration of declarations) {
      if (get(declaration, "name") !== undefined) normalized.push(toolFromDeclaration(declaration));
    }
  };

  for (const tool of tools) {
    const snake = get(tool, "function_declarations");

    if (snake !== undefined) {
      appendDeclarations(snake);
      continue;
    }

    const camel = get(tool, "functionDeclarations");

    if (camel !== undefined) {
      appendDeclarations(camel);
      continue;
    }

    if (get(tool, "name") !== undefined) normalized.push(toolFromDeclaration(tool));
  }

  if (normalized.length === 0) return set(out, "tools", cloneJson(tools));
  out = set(out, "tools", normalized);

  if (get(out, "tool_choice") === undefined) out = set(out, "tool_choice", "auto");

  return out;
};

const setRawIfDifferent = (out: Json, path: string, value: Json): Json => {
  const current = get(out, path);

  if (current !== undefined && JSON.stringify(current) === JSON.stringify(value)) return out;

  return set(out, path, cloneJson(value));
};

const copyTopLevel = (out: Json, root: Json): Json => {
  const tier = get(root, "service_tier");

  if (typeof tier === "string" && ["priority", "fast"].includes(tier.trim().toLowerCase())) {
    if (get(out, "service_tier") !== "priority") out = set(out, "service_tier", "priority");
  }

  const toolChoice = get(root, "tool_choice");

  if (toolChoice !== undefined) out = setRawIfDifferent(out, "tool_choice", toolChoice);

  for (const path of ["parallel_tool_calls", "store", "metadata", "include", "truncation"]) {
    const value = get(root, path);

    if (value !== undefined) out = setRawIfDifferent(out, path, value);
  }

  return out;
};

const REASONING_ENCRYPTED_CONTENT = "reasoning.encrypted_content";

/**
 * `ensureInteractionsCodexEncryptedContentInclude`: the request asks the upstream for encrypted reasoning content so a
 * signature can come back for replay.
 */
const ensureEncryptedContentInclude = (out: Json): Json => {
  const include = get(out, "include");

  if (include === undefined) return set(out, "include", [REASONING_ENCRYPTED_CONTENT]);

  if (!isJsonArray(include) || include.includes(REASONING_ENCRYPTED_CONTENT)) return out;

  return set(out, "include.-1", REASONING_ENCRYPTED_CONTENT);
};

/** `ConvertInteractionsRequestToCodex`. Throws `UnsupportedPartError` when a user turn is left empty. */
export const convertInteractionsRequestToCodex = (
  modelName: string,
  request: Json,
  stream: boolean,
): Json => {
  let out: Json = { model: "", instructions: "", store: false, input: [] };
  out = set(out, "model", modelName);

  if (stream || asBool(get(request, "stream"))) out = set(out, "stream", true);
  out = copySystem(out, request);
  out = copyGenerationConfig(out, request);
  const items: Json[] = [];

  const run = appendInput(
    items,
    get(request, "input"),
    resolveCodexReplayTargetModel(modelName, request),
  );

  if (items.length > 0) out = set(out, "input", items);
  out = copyTools(out, request);
  out = copyTopLevel(out, request);
  out = ensureEncryptedContentInclude(out);
  const err = run?.err(out);

  if (err !== undefined) throw err;

  return out;
};
