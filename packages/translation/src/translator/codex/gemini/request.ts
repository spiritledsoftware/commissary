/**
 * Gemini generateContent request -> Codex (Responses) request.
 *
 * Go source: internal/translator/codex/gemini/codex_gemini_request.go (ConvertGeminiRequestToCodex and helpers).
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
import { normalizeJsonSchemaNumericConstraints } from "../../common/schema.ts";
import { buildShortNameMap, shortenNameIfNeeded } from "../claude/request.ts";

/** `translatorcommon.IsGeminiThoughtPart`. */
export const isGeminiThoughtPart = (part: Json | undefined): boolean =>
  asBool(get(part, "thought"));

const normalizeServiceTier = (value: Json | undefined): string => {
  if (typeof value !== "string") return "";
  const tier = value.trim().toLowerCase();

  return tier === "priority" || tier === "fast" ? "priority" : "";
};

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

const firstNonEmpty = (root: Json | undefined, ...paths: string[]): string => {
  for (const path of paths) {
    const value = asString(get(root, path));

    if (value !== "") return value;
  }

  return "";
};

const contentPartFromInlineData = (part: Json): JsonObject | undefined => {
  let inlineData = get(part, "inlineData");

  if (inlineData === undefined) inlineData = get(part, "inline_data");

  if (inlineData === undefined) return undefined;
  const mimeType = firstNonEmpty(inlineData, "mimeType", "mime_type");
  const data = asString(get(inlineData, "data"));

  if (mimeType === "" || data === "") return undefined;
  const lower = mimeType.toLowerCase();

  if (lower.startsWith("image/"))
    return { type: "input_image", image_url: `data:${mimeType};base64,${data}` };

  if (lower.startsWith("audio/")) {
    return {
      type: "input_audio",
      input_audio: { data, format: codexInputAudioFormatFromMime(mimeType) },
    };
  }

  return { type: "input_file", file_data: data, filename: codexFileNameFromMime(mimeType) };
};

const contentPartFromFileData = (part: Json): JsonObject | undefined => {
  let fileData = get(part, "fileData");

  if (fileData === undefined) fileData = get(part, "file_data");

  if (fileData === undefined) return undefined;
  const fileUri = firstNonEmpty(fileData, "fileUri", "file_uri");

  if (fileUri === "") return undefined;
  const mimeType = firstNonEmpty(fileData, "mimeType", "mime_type");
  const lower = mimeType.toLowerCase();

  if (lower.startsWith("image/")) return { type: "input_image", image_url: fileUri };

  if (lower.startsWith("video/") || lower.startsWith("application/") || lower.startsWith("text/")) {
    return { type: "input_file", file_url: fileUri, filename: codexFileNameFromMime(mimeType) };
  }

  const info = `File: ${fileUri}${mimeType !== "" ? ` (Type: ${mimeType})` : ""}`;

  return { type: "input_text", text: info };
};

const messageWithPart = (role: string, part: Json): JsonObject => ({
  type: "message",
  role,
  content: [part],
});

/** `cleanGeminiCodexToolParameters`: drops `$schema` and forbids additional properties unless set to false. */
const cleanToolParameters = (parameters: Json): Json => {
  const cleaned = cloneJson(normalizeJsonSchemaNumericConstraints(parameters));

  if (!isJsonObject(cleaned)) return cleaned;

  if (cleaned["$schema"] !== undefined) delete cleaned["$schema"];

  if (cleaned["additionalProperties"] !== false) cleaned["additionalProperties"] = false;

  return cleaned;
};

const setToolChoiceFromToolConfig = (out: Json, config: Json | undefined): Json => {
  if (config === undefined) return out;

  switch (asString(get(config, "mode"))) {
    case "NONE":
      return set(out, "tool_choice", "none");
    case "AUTO":
      return get(out, "tool_choice") === "auto" ? out : set(out, "tool_choice", "auto");
    case "ANY": {
      const allowed = get(config, "allowedFunctionNames");

      if (isJsonArray(allowed) && allowed.length === 1) {
        return set(out, "tool_choice", {
          type: "function",
          name: shortenNameIfNeeded(asString(allowed[0])),
        });
      }

      return set(out, "tool_choice", "required");
    }

    default:
      return out;
  }
};

/** `util.Walk(tools, "", "type")` + lower-casing: every string `type` value under `tools` becomes lower case. */
const lowerCaseTypes = (value: Json | undefined): void => {
  if (isJsonArray(value)) {
    for (const item of value) lowerCaseTypes(item);
  } else if (isJsonObject(value)) {
    for (const key of Object.keys(value)) {
      const child = value[key];

      if (key === "type" && typeof child === "string") {
        const lower = child.toLowerCase();

        if (lower !== child) value[key] = lower;
      } else {
        lowerCaseTypes(child);
      }
    }
  }
};

const geminiFunctionNames = (tools: Json | undefined): string[] => {
  const names: string[] = [];

  if (!isJsonArray(tools)) return names;

  for (const tool of tools) {
    const fns = get(tool, "functionDeclarations");

    if (!isJsonArray(fns)) continue;

    for (const fn of fns) {
      const name = get(fn, "name");

      if (name !== undefined) names.push(asString(name));
    }
  }

  return names;
};

/** Names of `functionDeclarations` -> shortened names (shared with the response translator). */
export const geminiShortNameMap = (root: Json | undefined): Map<string, string> => {
  const names = geminiFunctionNames(get(root, "tools"));

  return names.length > 0 ? buildShortNameMap(names) : new Map();
};

/** `ConvertGeminiRequestToCodex`. */
export const convertGeminiRequestToCodex = (
  modelName: string,
  request: Json,
  _stream: boolean,
): Json => {
  let out: Json = { model: "", instructions: "", input: [] };
  const shortMap = geminiShortNameMap(request);
  const inputItems: Json[] = [];

  // Sequential pairing of generated call ids across possibly multiple in-flight functionCalls.
  let pendingCallIds: string[] = [];
  let callCounter = 0;
  const nextCallId = () => `call_gemini_${String(++callCounter).padStart(16, "0")}`;

  const geminiCallId = (value: Json | undefined): string => {
    const id = asString(get(value, "id")).trim();

    return id !== "" ? id : asString(get(value, "call_id")).trim();
  };

  out = set(out, "model", modelName);
  const serviceTier = normalizeServiceTier(get(request, "service_tier"));

  if (serviceTier !== "") out = set(out, "service_tier", serviceTier);

  // System instruction -> developer message with input_text parts.
  let sysParts = get(request, "system_instruction.parts");

  if (sysParts === undefined) sysParts = get(request, "systemInstruction.parts");

  if (isJsonArray(sysParts)) {
    const contentItems: Json[] = [];

    for (const p of sysParts) {
      if (isGeminiThoughtPart(p)) continue;
      const text = get(p, "text");

      if (text !== undefined) contentItems.push({ type: "input_text", text: asString(text) });
    }

    if (contentItems.length > 0)
      inputItems.push({ type: "message", role: "developer", content: contentItems });
  }

  const contents = get(request, "contents");

  if (isJsonArray(contents)) {
    for (const item of contents) {
      let role = asString(get(item, "role"));

      if (role === "model") role = "assistant";
      const parts = get(item, "parts");

      if (!isJsonArray(parts)) continue;

      for (const p of parts) {
        if (isGeminiThoughtPart(p)) continue;
        const text = get(p, "text");

        if (text !== undefined) {
          inputItems.push(
            messageWithPart(role, {
              type: role === "assistant" ? "output_text" : "input_text",
              text: asString(text),
            }),
          );
          continue;
        }

        const inline = contentPartFromInlineData(p);

        if (inline !== undefined) {
          inputItems.push(messageWithPart(role, inline));
          continue;
        }

        const file = contentPartFromFileData(p);

        if (file !== undefined) {
          inputItems.push(messageWithPart(role, file));
          continue;
        }

        const fc = get(p, "functionCall");

        if (fc !== undefined) {
          const fn: JsonObject = { type: "function_call" };
          const name = get(fc, "name");

          if (name !== undefined) {
            const n = asString(name);
            fn["name"] = shortMap.get(n) ?? shortenNameIfNeeded(n);
          }

          const args = get(fc, "args");

          if (args !== undefined) fn["arguments"] = JSON.stringify(args);
          // Reuse gateway-provided ids when present, otherwise generate one for pairing.
          let id = geminiCallId(fc);

          if (id === "") id = nextCallId();
          fn["call_id"] = id;
          pendingCallIds.push(id);
          inputItems.push(fn);
          continue;
        }

        const fr = get(p, "functionResponse");

        if (fr !== undefined) {
          const fno: JsonObject = { type: "function_call_output" };
          const result = get(fr, "response.result");

          if (result !== undefined) fno["output"] = asString(result);
          else {
            const response = get(fr, "response");

            if (response !== undefined) fno["output"] = JSON.stringify(response);
          }

          // Pair with the oldest queued call id (or the explicit one); generate when the queue is empty.
          let id: string;
          const customId = geminiCallId(fr);

          if (customId !== "") {
            id = customId;
            const at = pendingCallIds.indexOf(id);

            if (at >= 0)
              pendingCallIds = [...pendingCallIds.slice(0, at), ...pendingCallIds.slice(at + 1)];
          } else if (pendingCallIds.length > 0) {
            // SAFETY: the branch condition checked pendingCallIds.length > 0.
            id = pendingCallIds[0] as string;
            pendingCallIds = pendingCallIds.slice(1);
          } else {
            id = nextCallId();
          }

          fno["call_id"] = id;
          inputItems.push(fno);
        }
      }
    }
  }

  if (inputItems.length > 0) out = set(out, "input", inputItems);

  // Tools: functionDeclarations -> function tools.
  const tools = get(request, "tools");

  if (isJsonArray(tools)) {
    const toolItems: Json[] = [];
    out = set(out, "tool_choice", "auto");

    for (const td of tools) {
      const fns = get(td, "functionDeclarations");

      if (!isJsonArray(fns)) continue;

      for (const fn of fns) {
        const tool: JsonObject = { type: "function" };
        const name = get(fn, "name");

        if (name !== undefined) {
          const n = asString(name);
          tool["name"] = shortMap.get(n) ?? shortenNameIfNeeded(n);
        }

        const description = get(fn, "description");

        if (description !== undefined) tool["description"] = asString(description);
        const parameters = get(fn, "parameters") ?? get(fn, "parametersJsonSchema");

        if (parameters !== undefined) tool["parameters"] = cleanToolParameters(parameters);
        tool["strict"] = false;
        toolItems.push(tool);
      }
    }

    out = set(out, "tools", toolItems);
  }

  out = set(out, "parallel_tool_calls", true);
  out = setToolChoiceFromToolConfig(out, get(request, "toolConfig.functionCallingConfig"));

  // thinkingConfig -> reasoning.effort (the Python SDK sends snake_case fields).
  let effortSet = false;
  const genConfig = get(request, "generationConfig");

  if (genConfig !== undefined) {
    let thinkingLevel = get(genConfig, "thinkingLevel");

    if (thinkingLevel === undefined) thinkingLevel = get(genConfig, "thinking_level");
    const thinkingConfig = get(genConfig, "thinkingConfig");

    if (thinkingLevel !== undefined) {
      const effort = asString(thinkingLevel).trim().toLowerCase();

      if (effort !== "") {
        out = set(out, "reasoning.effort", effort);
        effortSet = true;
      }
    } else if (isJsonObject(thinkingConfig)) {
      let level = get(thinkingConfig, "thinkingLevel");

      if (level === undefined) level = get(thinkingConfig, "thinking_level");

      if (level !== undefined) {
        const effort = asString(level).trim().toLowerCase();

        if (effort !== "") {
          out = set(out, "reasoning.effort", effort);
          effortSet = true;
        }
      } else {
        let budget = get(thinkingConfig, "thinkingBudget");

        if (budget === undefined) budget = get(thinkingConfig, "thinking_budget");

        if (budget !== undefined) {
          const effort = convertBudgetToLevel(asInt(budget));

          if (effort !== undefined) {
            out = set(out, "reasoning.effort", effort);
            effortSet = true;
          }
        }
      }
    }
  }

  if (!effortSet) out = set(out, "reasoning.effort", "medium");
  out = set(out, "stream", true);
  out = set(out, "store", false);
  out = set(out, "include", ["reasoning.encrypted_content"]);
  lowerCaseTypes(get(out, "tools"));

  return out;
};
