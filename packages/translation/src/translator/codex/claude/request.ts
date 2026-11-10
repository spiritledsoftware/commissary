/**
 * Claude Messages request -> Codex (Responses) request.
 *
 * Go source: internal/translator/codex/claude/codex_claude_request.go (ConvertClaudeRequestToCodex and helpers).
 * `convertClaudeRequestToCodexWithCompat` keeps assistant thinking blocks with empty or unknown-format signatures for
 * `is-compat` models. Tool `input` is re-serialised compactly (Go forwards the raw text).
 */
import { createHash } from "node:crypto";
import {
  asBool,
  asInt,
  asString,
  cloneJson,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import { parseSuffix } from "../../../thinking/suffix.ts";
import { convertBudgetToLevel } from "../../../thinking/convert.ts";
import {
  alignClaudeToolResults,
  claudeMessageSystemReminderText,
  isClaudeCodeAttributionSystemText,
} from "../../common/claude-messages.ts";
import { isHttpUrl, UserTurnDrops } from "../../common/parts.ts";
import {
  hasUnsupportedUnicodePropertyEscape,
  SCHEMA_MAP_KEYWORDS,
  SCHEMA_VALUE_KEYWORDS,
} from "../../common/schema.ts";
import { isValidGrokEncryptedContent } from "../../../signature/grok.ts";
import {
  compatibleSignatureForProvider,
  detectSignatureProvider,
} from "../../../signature/provider.ts";

const NAME_LIMIT = 64;

/** `shortenNameIfNeeded` (Claude variant: no character sanitising). */
export const shortenNameIfNeeded = (name: string): string => {
  if (name.length <= NAME_LIMIT) return name;

  if (name.startsWith("mcp__")) {
    const index = name.lastIndexOf("__");

    if (index > 0) {
      const candidate = `mcp__${name.slice(index + 2)}`;

      return candidate.length > NAME_LIMIT ? candidate.slice(0, NAME_LIMIT) : candidate;
    }
  }

  return name.slice(0, NAME_LIMIT);
};

/** `buildShortNameMap`: unique names within the limit. */
export const buildShortNameMap = (names: readonly string[]): Map<string, string> => {
  const used = new Set<string>();
  const map = new Map<string, string>();

  const makeUnique = (candidate: string): string => {
    if (!used.has(candidate)) return candidate;

    for (let i = 1; ; i++) {
      const suffix = `_${i}`;
      const allowed = Math.max(0, NAME_LIMIT - suffix.length);
      const next = (candidate.length > allowed ? candidate.slice(0, allowed) : candidate) + suffix;

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

/** `buildReverseMapFromClaudeOriginalToShort`: original -> short names of the request's tools. */
export const buildOriginalToShortMap = (original: Json | undefined): Map<string, string> => {
  const tools = get(original, "tools");

  if (!isJsonArray(tools)) return new Map();
  const names = tools.map((tool) => asString(get(tool, "name"))).filter((name) => name !== "");

  return names.length > 0 ? buildShortNameMap(names) : new Map();
};

/** `shortenCodexCallIDIfNeeded`: keeps Claude tool ids within the 64 character `call_id` limit. */
export const shortenCodexCallIdIfNeeded = (id: string): string => {
  if (id.length <= NAME_LIMIT) return id;
  const suffix = `_${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
  const prefixLength = NAME_LIMIT - suffix.length;

  return prefixLength <= 0
    ? suffix.slice(suffix.length - NAME_LIMIT)
    : id.slice(0, prefixLength) + suffix;
};

const normalizeCodexServiceTier = (value: Json | undefined): string => {
  if (typeof value !== "string") return "";
  const tier = value.trim().toLowerCase();

  return tier === "fast" || tier === "priority" ? "priority" : "";
};

const isClaudeWebSearchToolType = (toolType: string): boolean =>
  toolType === "web_search_20250305" || toolType === "web_search_20260209";

const convertClaudeToolChoiceToCodex = (
  toolChoice: Json | undefined,
  toolNameMap: ReadonlyMap<string, string>,
  webSearchToolNames: ReadonlySet<string>,
): Json => {
  if (toolChoice === undefined || toolChoice === null) return "auto";
  let choiceType = asString(get(toolChoice, "type"));

  if (choiceType === "" && typeof toolChoice === "string") choiceType = toolChoice;

  switch (choiceType) {
    case "auto":
    case "":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool": {
      let name = asString(get(toolChoice, "name"));

      if (webSearchToolNames.has(name)) return { type: "web_search" };
      name = toolNameMap.get(name) ?? shortenNameIfNeeded(name);

      return name === "" ? "auto" : { type: "function", name };
    }

    default:
      return "auto";
  }
};

const convertClaudeWebSearchToolToCodex = (tool: Json): Json => {
  const out: Json = { type: "web_search" };
  const allowedDomains = get(tool, "allowed_domains");

  if (isJsonArray(allowedDomains)) set(out, "filters.allowed_domains", cloneJson(allowedDomains));
  const userLocation = get(tool, "user_location");

  if (isJsonObject(userLocation)) set(out, "user_location", cloneJson(userLocation));

  return out;
};

/** `stripDialectKeywordsFromSchema`: removes `$schema`/`$id` and unsupported regex patterns, recursively. */
const stripDialectKeywordsFromSchema = (value: Json | undefined): void => {
  if (isJsonArray(value)) {
    for (const item of value) stripDialectKeywordsFromSchema(item);

    return;
  }

  if (!isJsonObject(value)) return;
  delete value["$schema"];
  delete value["$id"];
  const pattern = value["pattern"];

  if (typeof pattern === "string" && hasUnsupportedUnicodePropertyEscape(pattern))
    delete value["pattern"];

  const patternProperties = value["patternProperties"];

  if (isJsonObject(patternProperties)) {
    for (const key of Object.keys(patternProperties)) {
      if (hasUnsupportedUnicodePropertyEscape(key)) delete patternProperties[key];
      else stripDialectKeywordsFromSchema(patternProperties[key]);
    }
  }

  for (const mapKey of SCHEMA_MAP_KEYWORDS) {
    if (mapKey === "patternProperties") continue;
    const sub = value[mapKey];

    if (isJsonObject(sub))
      for (const child of Object.values(sub)) stripDialectKeywordsFromSchema(child);
  }

  for (const valueKey of SCHEMA_VALUE_KEYWORDS) {
    const sub = value[valueKey];

    if (isJsonObject(sub) || isJsonArray(sub)) stripDialectKeywordsFromSchema(sub);
  }
};

const DEFAULT_PARAMETERS = (): Json => ({ type: "object", properties: {} });

/**
 * `normalizeToolParameters`: object schemas get an empty `properties`, dialect keywords and unsupported regex
 * patterns are dropped.
 */
export const normalizeToolParameters = (schema: Json | undefined): Json => {
  if (!isJsonObject(schema)) return DEFAULT_PARAMETERS();
  const root = cloneJson(schema);
  stripDialectKeywordsFromSchema(root);
  const type = root["type"];
  let isObject = false;

  if (type === undefined || type === null || type === "") {
    root["type"] = "object";
    isObject = true;
  } else if (type === "object") {
    isObject = true;
  } else if (isJsonArray(type)) {
    isObject = type.some((element) => element === "object");
  }

  if (isObject && (root["properties"] === undefined || root["properties"] === null))
    root["properties"] = {};

  return root;
};

/** `codexSchemaMissesRequired`: a declared property missing from its sibling `required` list (recursively). */
export const codexSchemaMissesRequired = (schema: Json | undefined): boolean => {
  if (isJsonArray(schema)) return schema.some((child) => codexSchemaMissesRequired(child));

  if (!isJsonObject(schema)) return false;
  const properties = schema["properties"];

  if (isJsonObject(properties)) {
    const required = schema["required"];

    if (!isJsonArray(required)) return Object.keys(properties).length > 0;
    const names = new Set(required.filter((item): item is string => typeof item === "string"));

    if (Object.keys(properties).some((name) => !names.has(name))) return true;
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const children = schema[keyword];

    if (
      isJsonObject(children) &&
      Object.values(children).some((child) => codexSchemaMissesRequired(child))
    ) {
      return true;
    }
  }

  for (const keyword of SCHEMA_VALUE_KEYWORDS) {
    const child = schema[keyword];

    if (child !== undefined && codexSchemaMissesRequired(child)) return true;
  }

  return false;
};

/** `claudeImageInputPart`: base64 -> data URL, http(s) url pass-through, file id -> `file_id`. */
const claudeImageInputPart = (source: Json | undefined): JsonObject | undefined => {
  if (source === undefined) return undefined;
  const part: JsonObject = { type: "input_image" };
  let data = asString(get(source, "data"));

  if (data === "") data = asString(get(source, "base64"));

  if (data !== "") {
    let mediaType = asString(get(source, "media_type"));

    if (mediaType === "") mediaType = asString(get(source, "mime_type"));

    if (mediaType === "") mediaType = "application/octet-stream";
    part["image_url"] = `data:${mediaType};base64,${data}`;
  } else if (asString(get(source, "type")) === "url" && isHttpUrl(asString(get(source, "url")))) {
    part["image_url"] = asString(get(source, "url")).trim();
  } else if (asString(get(source, "type")) === "file" && asString(get(source, "file_id")) !== "") {
    part["file_id"] = asString(get(source, "file_id"));
  } else {
    return undefined;
  }

  return part;
};

/** `claudeDocumentDataURL`: an inline PDF as a data URL; anything else is not representable. */
const claudeDocumentDataUrl = (part: Json): string | undefined => {
  const source = get(part, "source");

  if (asString(get(source, "type")) !== "base64") return undefined;
  const mediaType = asString(get(source, "media_type")).trim();

  if (mediaType.toLowerCase() !== "application/pdf") return undefined;
  let data = asString(get(source, "data"));

  if (data === "") data = asString(get(source, "base64"));

  return data === "" ? undefined : `data:${mediaType};base64,${data}`;
};

const targetAcceptsGrokSignature = (modelName: string): boolean =>
  parseSuffix(modelName).modelName.trim().toLowerCase().includes("grok");

const toolResultImagePart = (source: Json): JsonObject | undefined => {
  let data = asString(get(source, "data"));

  if (data === "") data = asString(get(source, "base64"));

  if (data === "") return undefined;
  let mediaType = asString(get(source, "media_type"));

  if (mediaType === "") mediaType = asString(get(source, "mime_type"));

  if (mediaType === "") mediaType = "application/octet-stream";

  return { type: "input_image", image_url: `data:${mediaType};base64,${data}` };
};

/** `ConvertClaudeRequestToCodex`. Throws `UnsupportedPartError` when a user turn is left with nothing to send. */
export const convertClaudeRequestToCodex = (
  modelName: string,
  request: Json,
  _stream: boolean,
): Json => convertClaudeRequest(modelName, request, false);

/** `ConvertClaudeRequestToCodexWithCompat`: thinking blocks with empty/unknown signatures are preserved. */
export const convertClaudeRequestToCodexWithCompat = (
  modelName: string,
  request: Json,
  _stream: boolean,
): Json => convertClaudeRequest(modelName, request, true);

const convertClaudeRequest = (
  modelName: string,
  request: Json,
  preserveEmptyThinkingBlocks: boolean,
): Json => {
  const drops = new UserTurnDrops();
  let template: Json = { model: "", instructions: "", input: [] };
  const toolNameMap = buildOriginalToShortMap(request);
  template = set(template, "model", modelName);
  const inputItems: Json[] = [];

  // System prompt -> developer message (Claude Code attribution blocks are dropped).
  const system = get(request, "system");

  if (system !== undefined) {
    const contentItems: Json[] = [];

    const appendSystemText = (text: string) => {
      if (text === "" || isClaudeCodeAttributionSystemText(text)) return;
      contentItems.push({ type: "input_text", text });
    };

    if (typeof system === "string") appendSystemText(system);
    else if (isJsonArray(system)) {
      for (const block of system)
        if (asString(get(block, "type")) === "text") appendSystemText(asString(get(block, "text")));
    }

    if (contentItems.length > 0)
      inputItems.push({ type: "message", role: "developer", content: contentItems });
  }

  const messages = get(request, "messages");

  if (isJsonArray(messages)) {
    let pendingToolUseIds: string[] = [];
    let pendingSystemReminders: Json[] = [];

    for (const message of messages) {
      const messageRole = asString(get(message, "role"));

      if (messageRole === "system") {
        const reminder = claudeMessageSystemReminderText(get(message, "content"));

        if (reminder !== undefined) {
          const item: Json = {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: reminder }],
          };

          if (pendingToolUseIds.length > 0) pendingSystemReminders.push(item);
          else inputItems.push(item);
        }

        continue;
      }

      let messageContents = get(message, "content");

      if (messageRole === "user" && pendingToolUseIds.length > 0 && isJsonArray(messageContents)) {
        messageContents = alignClaudeToolResults(messageContents, pendingToolUseIds);
      }

      pendingToolUseIds = [];
      let contentItems: Json[] = [];
      // Counts only what this turn itself sends, not system reminders flushed beside it.
      let turnSendable = 0;
      let bufferedSendable = 0;

      const flushReminders = () => {
        if (pendingSystemReminders.length > 0) {
          inputItems.push(...pendingSystemReminders);
          pendingSystemReminders = [];
        }
      };

      const flushMessage = () => {
        if (contentItems.length === 0) return;
        turnSendable += bufferedSendable;
        bufferedSendable = 0;
        inputItems.push({ type: "message", role: messageRole, content: contentItems });
        contentItems = [];
      };

      const appendTextContent = (text: string) => {
        contentItems.push({
          type: messageRole === "assistant" ? "output_text" : "input_text",
          text,
        });

        if (text !== "") bufferedSendable++;
      };

      const appendReasoningContent = (part: Json) => {
        if (messageRole !== "assistant") return;
        const rawSignature = asString(get(part, "signature"));
        let signature = compatibleSignatureForProvider("gpt", rawSignature);

        if (
          signature === undefined &&
          preserveEmptyThinkingBlocks &&
          typeof get(part, "signature") === "string" &&
          rawSignature.trim() !== "" &&
          detectSignatureProvider(rawSignature, "claude_thinking") === "unknown"
        ) {
          signature = rawSignature;
        }

        if (signature === undefined) {
          if (preserveEmptyThinkingBlocks && rawSignature.trim() === "") {
            signature = rawSignature;
          } else {
            if (!targetAcceptsGrokSignature(modelName)) return;

            if (!isValidGrokEncryptedContent(rawSignature)) return;
            signature = rawSignature;
          }
        }

        flushMessage();
        inputItems.push({
          type: "reasoning",
          summary: [],
          content: null,
          encrypted_content: signature,
        });
      };

      if (isJsonArray(messageContents)) {
        for (const part of messageContents) {
          const contentType = asString(get(part, "type"));

          switch (contentType) {
            case "text":
              flushReminders();
              appendTextContent(asString(get(part, "text")));
              break;
            case "thinking":
              appendReasoningContent(part);
              break;
            case "image": {
              flushReminders();
              const imagePart = claudeImageInputPart(get(part, "source"));

              if (imagePart !== undefined) {
                contentItems.push(imagePart);
                bufferedSendable++;
              } else if (messageRole === "user") {
                drops.drop(contentType);
              }

              break;
            }

            case "document":
            case "container_upload": {
              flushReminders();
              const dataUrl = claudeDocumentDataUrl(part);

              if (dataUrl !== undefined) {
                contentItems.push({
                  type: "input_file",
                  file_data: dataUrl,
                  filename: "document.pdf",
                });
                bufferedSendable++;
              } else if (messageRole === "user") {
                drops.drop(contentType);
              }

              break;
            }

            case "tool_use": {
              flushMessage();
              const id = asString(get(part, "id"));

              if (id !== "") pendingToolUseIds.push(id);
              const name = asString(get(part, "name"));
              const input = get(part, "input");
              inputItems.push({
                type: "function_call",
                call_id: shortenCodexCallIdIfNeeded(id),
                name: toolNameMap.get(name) ?? shortenNameIfNeeded(name),
                arguments: input === undefined ? "" : JSON.stringify(input),
              });
              break;
            }

            case "tool_result": {
              flushMessage();

              const output: JsonObject = {
                type: "function_call_output",
                call_id: shortenCodexCallIdIfNeeded(asString(get(part, "tool_use_id"))),
              };

              const content = get(part, "content");

              if (isJsonArray(content)) {
                const items: Json[] = [];

                for (const entry of content) {
                  const entryType = asString(get(entry, "type"));

                  if (entryType === "image") {
                    const source = get(entry, "source");
                    const image = source === undefined ? undefined : toolResultImagePart(source);

                    if (image !== undefined) items.push(image);
                  } else if (entryType === "text") {
                    items.push({ type: "input_text", text: asString(get(entry, "text")) });
                  }
                }

                output["output"] = items.length > 0 ? items : asString(content);
              } else {
                output["output"] = asString(content);
              }

              inputItems.push(output);
              turnSendable++;
              break;
            }
          }
        }

        flushMessage();
        flushReminders();
      } else if (typeof messageContents === "string") {
        appendTextContent(messageContents);
        flushMessage();
        flushReminders();
      }

      if (messageRole === "user") drops.endTurn(turnSendable);
    }

    inputItems.push(...pendingSystemReminders);
  }

  // Tools.
  const tools = get(request, "tools");
  let hasWebSearchTool = false;
  const toolItems: Json[] = [];

  if (isJsonArray(tools)) {
    const webSearchToolNames = new Set<string>();

    for (const tool of tools) {
      if (!isClaudeWebSearchToolType(asString(get(tool, "type")))) continue;
      const name = asString(get(tool, "name"));

      if (name !== "") webSearchToolNames.add(name);
    }

    template = set(
      template,
      "tool_choice",
      convertClaudeToolChoiceToCodex(get(request, "tool_choice"), toolNameMap, webSearchToolNames),
    );

    for (const toolResult of tools) {
      if (isClaudeWebSearchToolType(asString(get(toolResult, "type")))) {
        hasWebSearchTool = true;
        toolItems.push(convertClaudeWebSearchToolToCodex(toolResult));
        continue;
      }

      let tool = cloneJson(toolResult);

      if (get(toolResult, "type") !== "function") tool = set(tool, "type", "function");
      const nameValue = get(toolResult, "name");

      if (nameValue !== undefined) {
        const originalName = asString(nameValue);
        const name = toolNameMap.get(originalName) ?? shortenNameIfNeeded(originalName);

        if (typeof nameValue !== "string" || name !== originalName) tool = set(tool, "name", name);
      }

      tool = set(tool, "parameters", normalizeToolParameters(get(toolResult, "input_schema")));

      for (const path of ["input_schema", "parameters.$schema", "cache_control", "defer_loading"]) {
        if (get(tool, path) !== undefined) tool = del(tool, path);
      }

      if (get(tool, "strict") !== false) tool = set(tool, "strict", false);
      toolItems.push(tool);
    }
  }

  // Parallel tool calls unless tool_choice explicitly disables them.
  let parallelToolCalls = true;
  const disableParallel = get(request, "tool_choice.disable_parallel_tool_use");

  if (disableParallel !== undefined) parallelToolCalls = !asBool(disableParallel);
  template = set(template, "parallel_tool_calls", parallelToolCalls);

  // thinking.budget_tokens -> reasoning.effort.
  let reasoningEffort = "medium";
  const thinkingConfig = get(request, "thinking");

  if (isJsonObject(thinkingConfig)) {
    switch (asString(get(thinkingConfig, "type"))) {
      case "enabled": {
        const budgetTokens = get(thinkingConfig, "budget_tokens");

        if (budgetTokens !== undefined) {
          const effort = convertBudgetToLevel(asInt(budgetTokens));

          if (effort !== undefined && effort !== "") reasoningEffort = effort;
        }

        break;
      }

      case "adaptive":
      case "auto": {
        // Adaptive thinking can carry an explicit effort in output_config.effort; ApplyThinking clamps it later.
        const value = get(request, "output_config.effort");
        const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
        reasoningEffort = effort !== "" ? effort : "xhigh";
        break;
      }

      case "disabled": {
        const effort = convertBudgetToLevel(0);

        if (effort !== undefined && effort !== "") reasoningEffort = effort;
        break;
      }
    }
  } else if (thinkingConfig === undefined) {
    // Claude output_config.effort is independent of thinking activation: keep it when thinking is omitted.
    const value = get(request, "output_config.effort");
    const effort = typeof value === "string" ? value.trim().toLowerCase() : "";

    if (effort !== "") reasoningEffort = effort;
  }

  template = set(template, "reasoning.effort", reasoningEffort);
  let serviceTier = normalizeCodexServiceTier(get(request, "service_tier"));

  if (get(request, "speed") === "fast") serviceTier = "priority";

  if (serviceTier !== "") template = set(template, "service_tier", serviceTier);
  template = set(template, "stream", true);
  template = set(template, "store", false);
  const include = ["reasoning.encrypted_content"];

  if (hasWebSearchTool) include.push("web_search_call.action.sources");
  template = set(template, "include", include);

  // output_config.format (json_schema) -> text.format.
  const format = get(request, "output_config.format");

  if (
    isJsonObject(format) &&
    asString(get(format, "type")) === "json_schema" &&
    isJsonObject(get(format, "schema"))
  ) {
    const customName = asString(get(format, "name"));
    let strict = get(format, "strict") !== false;
    const schema = get(format, "schema");

    // OpenAI strict mode requires every declared property to be listed in `required`.
    if (strict && codexSchemaMissesRequired(schema)) strict = false;
    template = set(template, "text.format", {
      type: "json_schema",
      name: customName !== "" ? customName : "cli_proxy_structured_output",
      strict,
      schema: cloneJson(schema ?? null),
    });
  }

  if (isJsonArray(tools)) template = set(template, "tools", toolItems);

  if (inputItems.length > 0) template = set(template, "input", inputItems);
  const err = drops.err(template);

  if (err !== undefined) throw err;

  return template;
};
