/**
 * OpenAI Chat Completions request -> Codex (Responses) request.
 *
 * Go source: internal/translator/codex/openai/chat-completions/codex_openai_request.go
 * (ConvertOpenAIRequestToCodex and helpers). Temperature, top_p and token limits are intentionally not forwarded
 * (the Codex backend rejects them); system messages become `developer` messages.
 */
import {
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { unwrapApplyPatchInput } from "../../common/apply-patch.ts";
import { UserTurnDrops } from "../../common/parts.ts";
import { shortenCodexCallIdIfNeeded } from "../claude/request.ts";

/** `sanitizeToolName`: characters outside `[a-zA-Z0-9_-]` become `_`. */
export const sanitizeToolName = (name: string): string => {
  let out = "";

  for (const ch of name) out += /[a-zA-Z0-9_-]/.test(ch) ? ch : "_";

  return out;
};

const NAME_LIMIT = 64;

/** `shortenNameIfNeeded`: sanitises a name and keeps it within 64 characters (preserving `mcp__` + last segment). */
export const shortenNameIfNeeded = (name: string): string => {
  const sanitized = sanitizeToolName(name);

  if (sanitized.length <= NAME_LIMIT) return sanitized;

  if (sanitized.startsWith("mcp__")) {
    const index = sanitized.lastIndexOf("__");

    if (index > 0) {
      const candidate = `mcp__${sanitized.slice(index + 2)}`;

      return candidate.length > NAME_LIMIT ? candidate.slice(0, NAME_LIMIT) : candidate;
    }
  }

  return sanitized.slice(0, NAME_LIMIT);
};

/** `collectRequestToolNames`: unique tool names across declarations, `tool_choice` and assistant tool calls. */
export const collectRequestToolNames = (root: Json | undefined): string[] => {
  const names: string[] = [];
  const seen = new Set<string>();

  const add = (name: string) => {
    if (name === "" || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  const tools = get(root, "tools");

  if (isJsonArray(tools)) {
    for (const tool of tools) {
      switch (asString(get(tool, "type"))) {
        case "function":
          add(asString(get(tool, "function.name")));
          break;
        case "custom":
          add(asString(get(tool, "name")));
          break;
      }
    }
  }

  const toolChoice = get(root, "tool_choice");

  if (isJsonObject(toolChoice)) {
    switch (asString(get(toolChoice, "type"))) {
      case "function": {
        let name = asString(get(toolChoice, "function.name"));

        if (name === "") name = asString(get(toolChoice, "name"));
        add(name);
        break;
      }

      case "custom":
        add(asString(get(toolChoice, "name")));
        break;
    }
  }

  const messages = get(root, "messages");

  if (isJsonArray(messages)) {
    for (const message of messages) {
      if (asString(get(message, "role")) !== "assistant") continue;
      const toolCalls = get(message, "tool_calls");

      if (!isJsonArray(toolCalls)) continue;

      for (const call of toolCalls) {
        const name = asString(get(call, "function.name"));
        add(name !== "" ? name : asString(get(call, "custom.name")));
      }
    }
  }

  return names;
};

/** `buildShortNameMap`: unique short names (<= 64) per original name. */
export const buildShortNameMap = (names: readonly string[]): Map<string, string> => {
  const used = new Set<string>();
  const map = new Map<string, string>();

  const makeUnique = (candidate: string): string => {
    if (!used.has(candidate)) return candidate;

    for (let i = 1; ; i++) {
      const suffix = `_${i}`;
      const allowed = Math.max(0, NAME_LIMIT - suffix.length);
      const trimmed = candidate.length > allowed ? candidate.slice(0, allowed) : candidate;
      const next = trimmed + suffix;

      if (!used.has(next)) return next;
    }
  };

  for (const name of names) {
    const unique = makeUnique(shortenNameIfNeeded(name));
    used.add(unique);
    map.set(name, unique);
  }

  return map;
};

/** `normalizeCodexServiceTier`. */
export const normalizeCodexServiceTier = (value: Json | undefined): string => {
  if (typeof value !== "string") return "";

  switch (value.trim().toLowerCase()) {
    case "fast":
    case "priority":
      return "priority";
    case "ultrafast":
      return "ultrafast";
    default:
      return "";
  }
};

/** `codexInputFilePart`: a Chat Completions file part as `input_file`; `undefined` without file id, bytes or url. */
const codexInputFilePart = (item: Json | undefined): JsonObject | undefined => {
  const fileId = asString(get(item, "file.file_id"));
  const fileData = asString(get(item, "file.file_data"));
  const fileUrl = asString(get(item, "file.file_url"));

  if (fileId === "" && fileData === "" && fileUrl === "") return undefined;
  const part: JsonObject = { type: "input_file" };

  if (fileId !== "") part["file_id"] = fileId;

  if (fileData !== "") part["file_data"] = fileData;

  if (fileUrl !== "") part["file_url"] = fileUrl;
  const filename = asString(get(item, "file.filename"));

  if (filename !== "") part["filename"] = filename;

  return part;
};

const toolOutputFallbackPart = (item: Json | undefined): JsonObject => ({
  type: "input_text",
  text: item === undefined ? "" : JSON.stringify(item),
});

const toolOutputContentPart = (item: Json | undefined): JsonObject => {
  const itemType = asString(get(item, "type"));

  switch (itemType) {
    case "text":
    case "input_text":
    case "output_text":
      return { type: "input_text", text: asString(get(item, "text")) };
    case "image_url":
    case "input_image": {
      let imageUrl = asString(get(item, "image_url.url"));
      let fileId = asString(get(item, "image_url.file_id"));

      if (itemType === "input_image") {
        imageUrl = asString(get(item, "image_url"));
        fileId = asString(get(item, "file_id"));
      }

      if (imageUrl === "" && fileId === "") return toolOutputFallbackPart(item);
      const part: JsonObject = { type: "input_image" };

      if (imageUrl !== "") part["image_url"] = imageUrl;

      if (fileId !== "") part["file_id"] = fileId;

      const detail = asString(
        get(item, itemType === "input_image" ? "detail" : "image_url.detail"),
      );

      if (detail !== "") part["detail"] = detail;

      return part;
    }

    case "file":
      return codexInputFilePart(item) ?? toolOutputFallbackPart(item);
    default:
      return toolOutputFallbackPart(item);
  }
};

const hasToolOutputImagePart = (content: Json | undefined): boolean => {
  if (!isJsonArray(content)) return false;

  return content.some((item) => {
    switch (asString(get(item, "type"))) {
      case "image_url":
        return (
          asString(get(item, "image_url.url")) !== "" ||
          asString(get(item, "image_url.file_id")) !== ""
        );
      case "input_image":
        return asString(get(item, "image_url")) !== "" || asString(get(item, "file_id")) !== "";
      default:
        return false;
    }
  });
};

/** `setToolCallOutputContent`. */
const setToolCallOutputContent = (output: JsonObject, content: Json | undefined): void => {
  if (typeof content === "string") {
    // A JSON-encoded array of parts that carries images is expanded into structured output.
    const structured = tryParseJson(content);

    if (hasToolOutputImagePart(structured)) {
      setToolCallOutputContent(output, structured);

      return;
    }

    output["output"] = content;
  } else if (isJsonArray(content)) {
    output["output"] = content.map((item) => toolOutputContentPart(item));
  } else {
    // Go falls back to the raw text of the value (`content.Raw`), or its string form when it does not exist.
    output["output"] = content === undefined ? "" : JSON.stringify(content);
  }
};

interface PendingToolCall {
  readonly callId: string;
  readonly sourceCallId: string;
  readonly callType: "function" | "custom";
  consumed: boolean;
}

/** `ConvertOpenAIRequestToCodex`. Throws `UnsupportedPartError` when a user turn is left with nothing to send. */
export const convertOpenAIRequestToCodex = (
  modelName: string,
  body: Json,
  stream: boolean,
): Json => {
  const drops = new UserTurnDrops();
  const tools = get(body, "tools");
  const toolList: Json[] = isJsonArray(tools) ? tools : [];
  let out: Json = { instructions: "" };
  out = set(out, "stream", stream);

  const effort = get(body, "reasoning_effort");
  out = set(out, "reasoning.effort", effort !== undefined ? effort : "medium");
  const serviceTier = normalizeCodexServiceTier(get(body, "service_tier"));

  if (serviceTier !== "") out = set(out, "service_tier", serviceTier);
  // An explicit false survives; null, absent and anything else default to true (99d1698f).
  out = set(out, "parallel_tool_calls", get(body, "parallel_tool_calls") !== false);
  out = set(out, "include", ["reasoning.encrypted_content"]);
  out = set(out, "model", modelName);

  const customToolNames = new Set<string>();
  const functionToolNames = new Set<string>();
  let nameMap = new Map<string, string>();

  if (toolList.length > 0) {
    for (const tool of toolList) {
      switch (asString(get(tool, "type"))) {
        case "function":
          functionToolNames.add(asString(get(tool, "function.name")));
          break;
        case "custom":
          customToolNames.add(asString(get(tool, "name")));
          break;
      }
    }

    // A normalized function envelope cannot disambiguate declarations that share a name.
    for (const name of functionToolNames) customToolNames.delete(name);
  }

  const allNames = collectRequestToolNames(body);

  if (allNames.length > 0) nameMap = buildShortNameMap(allNames);
  const shortName = (name: string): string => nameMap.get(name) ?? shortenNameIfNeeded(name);

  const resolveToolCall = (
    toolCall: Json,
  ):
    | { readonly callType: "function" | "custom"; readonly name: string; readonly input: string }
    | undefined => {
    switch (asString(get(toolCall, "type"))) {
      case "custom":
        return {
          callType: "custom",
          name: asString(get(toolCall, "custom.name")),
          input: asString(get(toolCall, "custom.input")),
        };
      case "function": {
        const name = asString(get(toolCall, "function.name"));
        const callType = customToolNames.has(name) ? "custom" : "function";
        let input = asString(get(toolCall, "function.arguments"));

        if (callType === "custom" && name.trim() === "apply_patch") {
          // Only normalized function history carries the JSON envelope. Explicit custom input is raw.
          const unwrapped = unwrapApplyPatchInput(input);

          if ("input" in unwrapped) input = unwrapped.input;
        }

        return { callType, name, input };
      }

      default:
        return undefined;
    }
  };

  let pending: PendingToolCall[] = [];
  let ambiguous = new Set<string>();
  const inputItems: Json[] = [];
  const messages = get(body, "messages");

  if (isJsonArray(messages)) {
    messages.forEach((m, i) => {
      const role = asString(get(m, "role"));

      if (role === "tool") {
        let toolCallId = asString(get(m, "tool_call_id"));

        if (toolCallId !== "" && ambiguous.has(toolCallId)) return;

        const pendingCall = pending.find(
          (call) =>
            !call.consumed &&
            (toolCallId === "" || call.sourceCallId === toolCallId || call.callId === toolCallId),
        );

        if (pendingCall === undefined) return;
        pendingCall.consumed = true;
        toolCallId = pendingCall.callId;

        const output: JsonObject = {
          type:
            pendingCall.callType === "custom" ? "custom_tool_call_output" : "function_call_output",
          call_id: toolCallId,
        };

        setToolCallOutputContent(output, get(m, "content"));
        inputItems.push(output);

        return;
      }

      // A new conversational message starts a new tool-call batch.
      pending = [];
      ambiguous = new Set();
      const msg: JsonObject = { type: "message", role: role === "system" ? "developer" : role };
      const contentItems: Json[] = [];
      let turnSendable = 0;
      const textType = role === "assistant" ? "output_text" : "input_text";
      const content = get(m, "content");

      if (typeof content === "string" && content !== "") {
        turnSendable++;
        contentItems.push({ type: textType, text: content });
      } else if (isJsonArray(content)) {
        for (const it of content) {
          const t = asString(get(it, "type"));

          switch (t) {
            case "text": {
              contentItems.push({ type: textType, text: asString(get(it, "text")) });

              if (asString(get(it, "text")) !== "") turnSendable++;
              break;
            }

            case "image_url": {
              if (role !== "user") break;
              const part: JsonObject = { type: "input_image" };
              const url = get(it, "image_url.url");

              if (url !== undefined) part["image_url"] = asString(url);
              contentItems.push(part);
              turnSendable++;
              break;
            }

            case "file": {
              if (role !== "user") break;
              const part = codexInputFilePart(it);

              if (part !== undefined) {
                contentItems.push(part);
                turnSendable++;
              } else {
                drops.drop(t);
              }

              break;
            }

            case "input_audio": {
              if (role !== "user") break;
              const data = asString(get(it, "input_audio.data"));
              const format = asString(get(it, "input_audio.format"));

              if (data !== "") {
                const part: JsonObject = { type: "input_audio", data };

                if (format !== "") part["format"] = format;
                contentItems.push(part);
                turnSendable++;
              } else {
                drops.drop(t);
              }

              break;
            }
          }
        }
      }

      if (role === "user") drops.endTurn(turnSendable);

      // Do not emit empty assistant messages when only tool_calls are present: the Responses API needs
      // function_call items directly, otherwise call_id matching fails.
      if (role !== "assistant" || contentItems.length > 0) {
        msg["content"] = contentItems;
        inputItems.push(msg);
      }

      if (role !== "assistant") return;
      const toolCalls = get(m, "tool_calls");

      if (!isJsonArray(toolCalls)) return;
      const callIdCounts = new Map<string, number>();
      const usedCallIds = new Set<string>();

      for (const tc of toolCalls) {
        const callId = asString(get(tc, "id"));

        if (resolveToolCall(tc) !== undefined && callId !== "") {
          callIdCounts.set(callId, (callIdCounts.get(callId) ?? 0) + 1);
          usedCallIds.add(callId);
        }
      }

      for (const [callId, count] of callIdCounts) if (count > 1) ambiguous.add(callId);

      toolCalls.forEach((tc, j) => {
        const resolved = resolveToolCall(tc);

        if (resolved === undefined) return;
        const sourceCallId = asString(get(tc, "id"));

        if (sourceCallId !== "" && ambiguous.has(sourceCallId)) return;
        let callId = sourceCallId;

        if (callId === "") {
          const base = `call_missing_${i}_${j}`;
          callId = base;

          for (let suffix = 1; usedCallIds.has(callId); suffix++) callId = `${base}_${suffix}`;
          usedCallIds.add(callId);
        }

        // Codex rejects call_id values longer than 64 characters (b0debb35). The hash seeds from the id, and a
        // legal id that equals another's shortened form moves the later one on to the next attempt.
        let shortId = shortenCodexCallIdIfNeeded(callId);

        if (shortId !== callId) {
          for (let attempt = 1; usedCallIds.has(shortId); attempt++)
            shortId = shortenCodexCallIdIfNeeded(`${callId}_${attempt}`);
          usedCallIds.add(shortId);
          callId = shortId;
        }

        pending.push({ callId, sourceCallId, callType: resolved.callType, consumed: false });

        if (resolved.callType === "function") {
          inputItems.push({
            type: "function_call",
            call_id: callId,
            name: shortName(resolved.name),
            arguments: resolved.input,
          });
        } else {
          inputItems.push({
            type: "custom_tool_call",
            call_id: callId,
            name: shortName(resolved.name),
            input: resolved.input,
          });
        }
      });
    });
  }

  out = set(out, "input", inputItems);

  // Map response_format and text settings to Responses `text.format`.
  const rf = get(body, "response_format");
  const text = get(body, "text");

  if (rf !== undefined) {
    if (get(out, "text") === undefined) out = set(out, "text", {});

    switch (asString(get(rf, "type"))) {
      case "text":
        out = set(out, "text.format.type", "text");
        break;
      case "json_schema": {
        const js = get(rf, "json_schema");

        if (js !== undefined) {
          out = set(out, "text.format.type", "json_schema");
          const name = get(js, "name");

          if (name !== undefined) out = set(out, "text.format.name", name);
          const strict = get(js, "strict");

          if (strict !== undefined) out = set(out, "text.format.strict", strict);
          const schema = get(js, "schema");

          if (schema !== undefined) out = set(out, "text.format.schema", cloneJson(schema));
        }

        break;
      }
    }

    const verbosity = get(text, "verbosity");

    if (verbosity !== undefined) out = set(out, "text.verbosity", verbosity);
  } else if (text !== undefined) {
    const verbosity = get(text, "verbosity");

    if (verbosity !== undefined) {
      if (get(out, "text") === undefined) out = set(out, "text", {});
      out = set(out, "text.verbosity", verbosity);
    }
  }

  // Map tools (flatten function fields).
  if (toolList.length > 0) {
    const toolItems: Json[] = [];

    for (const t of toolList) {
      const toolType = asString(get(t, "type"));

      if (toolType === "custom") {
        const item = cloneJson(t);
        toolItems.push(set(item, "name", shortName(asString(get(t, "name")))));
        continue;
      }

      // Built-in tools (e.g. {"type":"web_search"}) pass through; only function and custom tools are converted.
      if (toolType !== "" && toolType !== "function" && isJsonObject(t)) {
        toolItems.push(cloneJson(t));
        continue;
      }

      if (toolType === "function") {
        const item: JsonObject = { type: "function" };
        const fn = get(t, "function");

        if (fn !== undefined) {
          const name = get(fn, "name");

          if (name !== undefined) item["name"] = shortName(asString(name));
          const description = get(fn, "description");

          if (description !== undefined) item["description"] = description;
          const parameters = get(fn, "parameters");

          if (parameters !== undefined) item["parameters"] = cloneJson(parameters);
          const strict = get(fn, "strict");
          // Chat Completions defaults strict to false while Responses defaults it to true.
          item["strict"] = strict !== undefined ? strict : false;
        }

        toolItems.push(item);
      }
    }

    out = set(out, "tools", toolItems);
  }

  // tool_choice: keep built-in choices as-is and flatten named choices to {"type","name"}.
  const toolChoice = get(body, "tool_choice");

  if (toolChoice !== undefined) {
    if (typeof toolChoice === "string") {
      out = set(out, "tool_choice", toolChoice);
    } else if (isJsonObject(toolChoice)) {
      let tcType = asString(get(toolChoice, "type"));

      if (tcType === "function" || tcType === "custom") {
        let name = asString(get(toolChoice, "name"));

        if (tcType === "function") {
          name = asString(get(toolChoice, "function.name"));

          if (customToolNames.has(name)) tcType = "custom";
        }

        if (name !== "") name = shortName(name);
        const choice: JsonObject = { type: tcType };

        if (name !== "") choice["name"] = name;
        out = set(out, "tool_choice", choice);
      } else if (tcType !== "") {
        out = set(out, "tool_choice", cloneJson(toolChoice));
      }
    }
  }

  out = set(out, "store", false);
  const err = drops.err(out);

  if (err !== undefined) throw err;

  return out;
};
