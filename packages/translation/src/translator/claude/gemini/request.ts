/**
 * Gemini client -> Claude Messages provider (request).
 *
 * Go source: internal/translator/claude/gemini/claude_gemini_request.go.
 */
import { asFloat, asInt, get, type Json, type JsonObject } from "@commissary/json";
import {
  applyTranslatedSummaryToClaude,
  convertBudgetToLevel,
  convertLevelToBudget,
  hasLevel,
  mapToClaudeEffort,
} from "../../../thinking/index.ts";
import { lookupModelInfo } from "../../model-info.ts";
import { ClaudeMessageAccumulator } from "../../common/claude-messages.ts";
import { deriveClaudeUserID } from "../../common/claude-user-id.ts";
import { sanitizeClaudeFunctionName } from "../../common/claude-util.ts";
import { exists, isArr, isObj, str, trimmed } from "../../common/gjson.ts";
import { isGeminiThoughtPart } from "../../common/gemini-parts.ts";
import { UserTurnDrops } from "../../common/parts.ts";

const first = (...values: Array<Json | undefined>): Json | undefined =>
  values.find((value) => value !== undefined);

/** `ConvertGeminiRequestToClaude`. */
export const convertGeminiRequestToClaude = (
  modelName: string,
  root: Json,
  stream: boolean,
): Json => {
  const drops = new UserTurnDrops();

  const out: JsonObject = {
    model: "",
    max_tokens: 32000,
    messages: [],
    metadata: { user_id: deriveClaudeUserID(root) },
  };

  const accumulator = new ClaudeMessageAccumulator();

  const toolIdOf = (value: Json | undefined): string => {
    const id = trimmed(get(value, "id"));

    return id !== "" ? id : trimmed(get(value, "call_id"));
  };

  // FIFO queue of generated tool ids; Gemini pairs responses to calls sequentially.
  let pendingToolIds: string[] = [];
  let toolCallCounter = 0;

  const nextToolId = (): string => {
    toolCallCounter++;

    return `toolu_gemini_${String(toolCallCounter).padStart(16, "0")}`;
  };

  out.model = modelName;
  const serviceTier = get(root, "service_tier");

  if (typeof serviceTier === "string") out.service_tier = serviceTier;

  const genConfig = get(root, "generationConfig");

  if (exists(genConfig)) {
    const maxTokens = get(genConfig, "maxOutputTokens");

    if (exists(maxTokens)) out.max_tokens = asInt(maxTokens);
    const topP = get(genConfig, "topP");

    if (exists(topP)) out.top_p = asFloat(topP);
    const stopSeqs = get(genConfig, "stopSequences");

    if (isArr(stopSeqs) && stopSeqs.length > 0)
      out.stop_sequences = stopSeqs.map((value) => str(value));

    const thinkingConfig = get(genConfig, "thinkingConfig");

    if (isObj(thinkingConfig)) {
      const mi = lookupModelInfo(modelName, "claude");
      const supportsAdaptive = (mi?.thinking?.levels?.length ?? 0) > 0;
      const supportsMax = supportsAdaptive && hasLevel(mi?.thinking?.levels, "max");
      const supportsDynamic = supportsAdaptive && mi?.thinking?.dynamicAllowed === true;

      const setThinking = (type: string): JsonObject => {
        const current = isObj(out.thinking) ? out.thinking : {};
        current.type = type;
        delete current.budget_tokens;
        out.thinking = current;

        return current;
      };

      const clearEffort = (): void => {
        if (isObj(out.output_config)) delete out.output_config.effort;
      };

      const setEffort = (effort: string): void => {
        const config = isObj(out.output_config) ? out.output_config : {};
        config.effort = effort;
        out.output_config = config;
      };

      const thinkingLevel = first(
        get(thinkingConfig, "thinkingLevel"),
        get(thinkingConfig, "thinking_level"),
      );

      if (exists(thinkingLevel)) {
        let level = str(thinkingLevel).trim().toLowerCase();

        if (supportsAdaptive) {
          if (level === "none") {
            setThinking("disabled");
            clearEffort();
          } else if (level === "auto" && supportsDynamic) {
            setThinking("adaptive");
            clearEffort();
          } else if (level !== "") {
            if (!hasLevel(mi?.thinking?.levels, level))
              level = mapToClaudeEffort(level, supportsMax) ?? level;
            setThinking("adaptive");
            setEffort(level);
          }
        } else if (level === "none") {
          setThinking("disabled");
        } else if (level === "auto") {
          setThinking("enabled");
        } else if (level !== "") {
          const budget = convertLevelToBudget(level);

          if (budget !== undefined) {
            const thinking = setThinking("enabled");
            thinking.budget_tokens = budget;
          }
        }
      } else {
        const thinkingBudget = first(
          get(thinkingConfig, "thinkingBudget"),
          get(thinkingConfig, "thinking_budget"),
        );

        if (exists(thinkingBudget)) {
          const budget = asInt(thinkingBudget);

          if (supportsAdaptive) {
            if (budget === 0) {
              setThinking("disabled");
              clearEffort();
            } else if (budget === -1 && supportsDynamic) {
              setThinking("adaptive");
              clearEffort();
            } else {
              let level = convertBudgetToLevel(budget);

              if (level !== undefined) {
                if (!hasLevel(mi?.thinking?.levels, level))
                  level = mapToClaudeEffort(level, supportsMax) ?? level;
                setThinking("adaptive");
                setEffort(level);
              }
            }
          } else if (budget === 0) {
            setThinking("disabled");
          } else if (budget === -1) {
            setThinking("enabled");
          } else {
            const thinking = setThinking("enabled");
            thinking.budget_tokens = budget;
          }
        }
      }
    }
  }

  const sysInstr = first(get(root, "systemInstruction"), get(root, "system_instruction"));

  if (exists(sysInstr)) {
    const parts = get(sysInstr, "parts");

    if (isArr(parts)) {
      let systemText = "";

      for (const part of parts) {
        if (isGeminiThoughtPart(part)) continue;
        const text = get(part, "text");

        if (exists(text)) {
          if (systemText !== "") systemText += "\n";
          systemText += str(text);
        }
      }

      if (systemText !== "") {
        accumulator.append({ role: "user", content: [{ type: "text", text: systemText }] });
        accumulator.flush();
      }
    }
  }

  const contents = get(root, "contents");

  if (isArr(contents)) {
    for (const content of contents) {
      let role = str(get(content, "role"));

      if (role === "model") role = "assistant";

      if (role === "function" || role === "tool") role = "user";

      const contentItems: JsonObject[] = [];
      let sendable = 0;
      const parts = get(content, "parts");

      if (isArr(parts)) {
        for (const part of parts) {
          if (isGeminiThoughtPart(part)) continue;

          const text = get(part, "text");

          if (exists(text)) {
            contentItems.push({ type: "text", text: str(text) });

            if (str(text).trim() !== "") sendable++;
            continue;
          }

          const fc = get(part, "functionCall");

          if (exists(fc) && role === "assistant") {
            let toolId = toolIdOf(fc);

            if (toolId === "") toolId = nextToolId();
            pendingToolIds.push(toolId);
            const toolUse: JsonObject = { type: "tool_use", id: toolId, name: "", input: {} };
            const name = get(fc, "name");

            if (exists(name)) toolUse.name = sanitizeClaudeFunctionName(str(name));
            const args = get(fc, "args");

            if (isObj(args)) toolUse.input = args;
            contentItems.push(toolUse);
            sendable++;
            continue;
          }

          const fr = get(part, "functionResponse");

          if (exists(fr)) {
            let toolId: string;
            const customId = toolIdOf(fr);

            if (customId !== "") {
              toolId = customId;
              const idx = pendingToolIds.indexOf(toolId);

              if (idx >= 0)
                pendingToolIds = [
                  ...pendingToolIds.slice(0, idx),
                  ...pendingToolIds.slice(idx + 1),
                ];
            } else if (pendingToolIds.length > 0) {
              // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
              toolId = pendingToolIds[0] as string;
              pendingToolIds = pendingToolIds.slice(1);
            } else {
              toolId = nextToolId();
            }

            const toolResult: JsonObject = {
              type: "tool_result",
              tool_use_id: toolId,
              content: "",
            };

            const result = get(fr, "response.result");

            if (exists(result)) toolResult.content = str(result);
            else {
              const response = get(fr, "response");

              if (exists(response)) toolResult.content = JSON.stringify(response);
            }

            contentItems.push(toolResult);
            sendable++;
            continue;
          }

          const inlineData = first(get(part, "inlineData"), get(part, "inline_data"));

          if (exists(inlineData)) {
            const block = contentPartFromInlineData(inlineData, role === "assistant");

            if (block !== undefined) {
              contentItems.push(block);
              sendable++;
            } else if (role !== "assistant") drops.drop("inlineData");
            continue;
          }

          const fileData = first(get(part, "fileData"), get(part, "file_data"));

          if (exists(fileData)) {
            const block = contentPartFromFileData(fileData);

            if (block !== undefined) {
              contentItems.push(block);
              sendable++;
            } else if (role !== "assistant") drops.drop("fileData");
          }
        }
      }

      if (role !== "assistant") drops.endTurn(sendable);

      if (contentItems.length > 0) accumulator.append({ role, content: contentItems });
    }
  }

  out.messages = accumulator.messages();

  const tools = get(root, "tools");

  if (isArr(tools)) {
    const anthropicTools: JsonObject[] = [];

    for (const tool of tools) {
      const funcDecls = get(tool, "functionDeclarations");

      if (!isArr(funcDecls)) continue;

      for (const funcDecl of funcDecls) {
        const anthropicTool: JsonObject = {
          name: "",
          description: "",
          input_schema: { type: "object", properties: {} },
        };

        const name = get(funcDecl, "name");

        if (exists(name)) anthropicTool.name = sanitizeClaudeFunctionName(str(name));
        const desc = get(funcDecl, "description");

        if (exists(desc)) anthropicTool.description = str(desc);
        const params = first(get(funcDecl, "parameters"), get(funcDecl, "parametersJsonSchema"));

        if (exists(params)) anthropicTool.input_schema = normalizeClaudeToolSchema(params);
        lowercaseSchemaTypes(anthropicTool);
        anthropicTools.push(anthropicTool);
      }
    }

    if (anthropicTools.length > 0) out.tools = anthropicTools;
  }

  const toolConfig = get(root, "tool_config");

  if (exists(toolConfig)) setToolChoice(out, get(toolConfig, "function_calling_config"));
  else {
    const camel = get(root, "toolConfig");

    if (exists(camel)) setToolChoice(out, get(camel, "functionCallingConfig"));
  }

  out.stream = stream;

  const result =
    applyTranslatedSummaryToClaude(out, root, "gemini", modelName, lookupModelInfo) ?? out;

  const refusal = drops.err(result);

  if (refusal !== undefined) throw refusal;

  return result;
};

const SCHEMA = "http://json-schema.org/draft-07/schema#";

const normalizeClaudeToolSchema = (parameters: Json): Json => {
  if (!isObj(parameters)) return parameters;
  const cleaned: JsonObject = { ...parameters };

  if (cleaned.additionalProperties !== false) cleaned.additionalProperties = false;

  if (cleaned.$schema !== SCHEMA) cleaned.$schema = SCHEMA;

  return cleaned;
};

type Path = Array<string | number>;

const collectTypePaths = (node: Json, path: Path, paths: Path[]): void => {
  const children: Array<[string | number, Json]> = isArr(node)
    ? node.map((child, index): [number, Json] => [index, child])
    : isObj(node)
      ? Object.entries(node)
      : [];

  for (const [key, child] of children) {
    const childPath = [...path, key];

    if (key === "type") paths.push(childPath);
    collectTypePaths(child, childPath, paths);
  }
};

const getAt = (root: Json, path: Path): Json | undefined => {
  let current: Json | undefined = root;

  for (const segment of path) {
    if (isArr(current) && typeof segment === "number") current = current[segment];
    else if (isObj(current) && Object.hasOwn(current, String(segment)))
      current = current[String(segment)];
    else return undefined;
  }

  return current;
};

const readChild = (holder: JsonObject | Json[], segment: string | number): Json | undefined => {
  if (!isArr(holder)) return holder[String(segment)];

  return typeof segment === "number" ? holder[segment] : undefined;
};

const writeChild = (holder: JsonObject | Json[], segment: string | number, value: Json): void => {
  if (!isArr(holder)) holder[String(segment)] = value;
  else if (typeof segment === "number") holder[segment] = value;
};

/** sjson-like set: a non-container parent along the path is replaced by an object. */
const setAt = (root: JsonObject, path: Path, value: Json): void => {
  let current: JsonObject | Json[] = root;

  for (const [i, segment] of path.entries()) {
    if (i === path.length - 1) {
      writeChild(current, segment, value);

      return;
    }

    let next = readChild(current, segment);

    if (!isObj(next) && !isArr(next)) {
      next = {};
      writeChild(current, segment, next);
    }

    current = next;
  }
};

/**
 * `lowercaseClaudeToolSchemaTypes`: every `type` key (any depth) is lower-cased. Non-string values are rewritten
 * as lower-cased JSON text, exactly like the Go path-based rewrite (including its effect on nested paths).
 */
const lowercaseSchemaTypes = (tool: JsonObject): void => {
  const paths: Path[] = [];
  collectTypePaths(tool, [], paths);

  for (const path of paths) {
    const value = getAt(tool, path);
    const lowered = str(value).toLowerCase();

    if (typeof value === "string" && lowered === value) continue;
    setAt(tool, path, lowered);
  }
};

const setToolChoice = (out: JsonObject, funcCalling: Json | undefined): void => {
  if (!exists(funcCalling)) return;
  const mode = get(funcCalling, "mode");

  if (!exists(mode)) return;

  switch (str(mode)) {
    case "AUTO":
      out.tool_choice = { type: "auto" };
      break;
    case "NONE":
      out.tool_choice = { type: "none" };
      break;
    case "ANY": {
      const allowed = first(
        get(funcCalling, "allowedFunctionNames"),
        get(funcCalling, "allowed_function_names"),
      );

      if (isArr(allowed) && allowed.length === 1)
        out.tool_choice = { type: "tool", name: sanitizeClaudeFunctionName(str(allowed[0])) };
      else out.tool_choice = { type: "any" };
      break;
    }
  }
};

const contentPartFromInlineData = (
  inlineData: Json,
  keepPlaceholder: boolean,
): JsonObject | undefined => {
  let mimeType = str(get(inlineData, "mimeType"));

  if (mimeType === "") mimeType = str(get(inlineData, "mime_type"));
  const data = str(get(inlineData, "data"));

  if (mimeType === "" || data === "") return undefined;
  const lower = mimeType.toLowerCase();

  if (lower.startsWith("image/"))
    return { type: "image", source: { type: "base64", media_type: mimeType, data } };

  if (lower.startsWith("application/") || lower.startsWith("text/")) {
    return { type: "document", source: { type: "base64", media_type: mimeType, data } };
  }

  return keepPlaceholder
    ? { type: "text", text: `Media content: inline data (Type: ${mimeType})` }
    : undefined;
};

const contentPartFromFileData = (fileData: Json): JsonObject | undefined => {
  let fileUri = str(get(fileData, "fileUri"));

  if (fileUri === "") fileUri = str(get(fileData, "file_uri"));

  if (fileUri === "") return undefined;
  let mimeType = str(get(fileData, "mimeType"));

  if (mimeType === "") mimeType = str(get(fileData, "mime_type"));
  const lower = mimeType.toLowerCase();

  if (lower.startsWith("image/")) return { type: "image", source: { type: "url", url: fileUri } };

  if (lower.startsWith("application/") || lower.startsWith("text/")) {
    const source: JsonObject = { type: "url", url: fileUri };

    if (mimeType !== "") source.media_type = mimeType;

    return { type: "document", source };
  }

  let info = `File: ${fileUri}`;

  if (mimeType !== "") info += ` (Type: ${mimeType})`;

  return { type: "text", text: info };
};
