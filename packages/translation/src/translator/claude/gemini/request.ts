/**
 * Gemini client -> Claude Messages provider (request).
 *
 * Go source: internal/translator/claude/gemini/claude_gemini_request.go.
 */
import { asFloat, asInt, get, type Json, type JsonObject } from "@commissary/json";
import {
  applyTranslatedSummaryToClaude,
  convertLevelToBudget,
  hasLevel,
  mapToClaudeEffort,
} from "../../../thinking/index.ts";
import { lookupModelInfo } from "../../model-info.ts";
import { ClaudeMessageAccumulator } from "../../common/claude-messages.ts";
import { deriveClaudeUserID } from "../../common/claude-user-id.ts";
import { normalizeJsonSchemaNumericConstraints } from "../../common/schema.ts";
import { sanitizeClaudeFunctionName } from "../../common/claude-util.ts";
import { exists, isArr, isObj, str, trimmed } from "../../common/gjson.ts";
import {
  geminiPartFunctionCall,
  geminiPartFunctionResponse,
  geminiPartsHaveFunctionCall,
  geminiPartsHaveFunctionResponse,
  isGeminiThoughtPart,
  normalizeGeminiTurnRole,
} from "../../common/gemini-parts.ts";
import { UnsupportedPartError, UserTurnDrops } from "../../common/parts.ts";
import { isLiteralValueKeyword, SCHEMA_NAME_MAP_KEYWORDS } from "../../common/schema-refs.ts";

const first = (...values: Array<Json | undefined>): Json | undefined =>
  values.find((value) => value !== undefined);

/**
 * `orderGeminiClaudeToolResults`: tool results come before other user content, including when adjacent Gemini user
 * turns were merged into one Claude turn (CLIProxyAPI 55c05f70). Edits the messages in place.
 */
const orderToolResults = (messages: JsonObject[]): void => {
  for (const message of messages) {
    const content = message.content;

    if (message.role !== "user" || !Array.isArray(content)) continue;
    const results = content.filter((part) => get(part, "type") === "tool_result");
    const other = content.filter((part) => get(part, "type") !== "tool_result");
    const merged = [...results, ...other];

    if (merged.some((part, index) => part !== content[index])) message.content = merged;
  }
};

/** `ConvertGeminiRequestToClaude`. */
export const convertGeminiRequestToClaude = (
  modelName: string,
  root: Json,
  stream: boolean,
): Json => {
  const drops = new UserTurnDrops();
  // A tool result whose only content was media Claude cannot take refuses the request (34d8fe0f).
  let toolOutputRefusedType: string | undefined;

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

          // A positive budget stays a budget for the model-aware validation after translation (a308c55b).
          if (budget === 0) {
            setThinking("disabled");
            clearEffort();
          } else if (budget === -1 && supportsAdaptive) {
            setThinking("adaptive");

            if (supportsDynamic) clearEffort();
            else setEffort("high");
          } else if (budget === -1) {
            setThinking("enabled");
          } else if (budget > 0 || !supportsAdaptive) {
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
    let previousRole = "";

    for (const content of contents) {
      const parts = get(content, "parts");
      let role = normalizeGeminiTurnRole(str(get(content, "role")), parts, previousRole);
      // Some Gemini clients label tool results as model turns; Claude requires user turns.
      const hasFunctionResponse = geminiPartsHaveFunctionResponse(parts);

      if (hasFunctionResponse && !geminiPartsHaveFunctionCall(parts)) role = "user";

      let contentItems: JsonObject[] = [];
      let sendable = 0;

      const flushContent = (): void => {
        if (role !== "assistant") drops.endTurn(sendable);

        if (contentItems.length > 0) accumulator.append({ role, content: contentItems });
        contentItems = [];
        sendable = 0;
      };

      // Split mixed function calls and results without losing their order or ids.
      const switchRole = (nextRole: string): void => {
        if (role === nextRole) return;
        flushContent();
        role = nextRole;
      };

      if (isArr(parts)) {
        for (const part of parts) {
          if (isGeminiThoughtPart(part)) continue;

          const text = get(part, "text");

          if (exists(text)) {
            contentItems.push({ type: "text", text: str(text) });

            if (str(text).trim() !== "") sendable++;
            continue;
          }

          const fc = geminiPartFunctionCall(part);

          if (exists(fc) && (role === "assistant" || hasFunctionResponse)) {
            switchRole("assistant");
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

          const fr = geminiPartFunctionResponse(part);

          if (exists(fr)) {
            switchRole("user");
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

            const refusedType = setToolResultContentFromGemini(
              toolResult,
              fr,
              role === "assistant",
              drops,
            );

            toolOutputRefusedType ??= refusedType;

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

      flushContent();
      previousRole = role;
    }
  }

  const messages = accumulator.messages();
  orderToolResults(messages);
  out.messages = messages;

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

  const refusal =
    drops.err(result) ??
    (toolOutputRefusedType === undefined
      ? undefined
      : new UnsupportedPartError(toolOutputRefusedType, result));

  if (refusal !== undefined) throw refusal;

  return result;
};

const SCHEMA = "http://json-schema.org/draft-07/schema#";

const normalizeClaudeToolSchema = (parameters: Json): Json => {
  if (!isObj(parameters)) return parameters;
  const normalized = normalizeJsonSchemaNumericConstraints(parameters);
  const cleaned: JsonObject = { ...(isObj(normalized) ? normalized : parameters) };

  if (cleaned.additionalProperties !== false) cleaned.additionalProperties = false;

  if (cleaned.$schema !== SCHEMA) cleaned.$schema = SCHEMA;

  return cleaned;
};

type Path = Array<string | number>;

/** `isPropertyDefinition`: whether `path` names a property (an odd run of name-map keywords ends it). */
const isPropertyDefinition = (path: Path): boolean => {
  let trailing = 0;

  for (let i = path.length - 1; i >= 0; i--) {
    const segment = path[i];

    if (typeof segment !== "string" || !SCHEMA_NAME_MAP_KEYWORDS.has(segment)) break;
    trailing++;
  }

  return trailing % 2 === 1;
};

/** `WalkSchema` for `type`: literal values (`enum`, `const`, `default`, ...) are client data, not subschemas. */
const collectTypePaths = (node: Json, path: Path, paths: Path[]): void => {
  const children: Array<[string | number, Json]> = isArr(node)
    ? node.map((child, index): [number, Json] => [index, child])
    : isObj(node)
      ? Object.entries(node)
      : [];

  for (const [key, child] of children) {
    const childPath = [...path, key];

    if (key === "type") paths.push(childPath);

    if (typeof key === "string" && isLiteralValueKeyword(key) && !isPropertyDefinition(path))
      continue;
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
 * `lowercaseClaudeToolSchemaTypes`: every string `type` keyword of the tool's `input_schema` is lower-cased; a
 * non-string `type` (a property named `type`, a type list) is kept (9b4f3f30). Each value is read from the tool as it
 * was before the rewrite (Go reads the original bytes since `6e6afab9`).
 */
const lowercaseSchemaTypes = (tool: JsonObject): void => {
  const schema = tool.input_schema;

  if (schema === undefined) return;
  const paths: Path[] = [];
  collectTypePaths(schema, ["input_schema"], paths);
  const original = structuredClone(tool);

  for (const path of paths) {
    const value = getAt(original, path);

    if (typeof value !== "string") continue;
    const lowered = value.toLowerCase();

    if (lowered !== value) setAt(tool, path, lowered);
  }
};

const isEmptyResponseObject = (value: Json | undefined): boolean =>
  value === undefined || (isObj(value) && Object.keys(value).length === 0);

/** `geminiClaudeResponseHasOnlyResultKey`. */
const responseHasOnlyResultKey = (response: Json | undefined): boolean =>
  isObj(response) && Object.keys(response).length === 1 && Object.hasOwn(response, "result");

/**
 * `setClaudeToolResultContentFromGemini`: a function response's nested `parts` become content blocks after its
 * response text, relaying their media (34d8fe0f). Media Claude cannot take is dropped from a user turn; when nothing
 * else carried the result, the request is refused: the returned part type names the dropped media.
 */
const setToolResultContentFromGemini = (
  toolResult: JsonObject,
  fr: Json,
  isAssistant: boolean,
  drops: UserTurnDrops,
): string | undefined => {
  const result = get(fr, "response.result");
  const response = get(fr, "response");
  const onlyResult = exists(result) && responseHasOnlyResultKey(response);
  let baseText = "";
  let hasBaseText = false;

  if (onlyResult) {
    baseText = str(result);
    hasBaseText = baseText.trim() !== "";
  } else if (!isEmptyResponseObject(response)) {
    baseText = JSON.stringify(response);
    hasBaseText = true;
  }

  const nestedBlocks: JsonObject[] = [];
  let droppedType = "";
  const frParts = get(fr, "parts");

  for (const nested of isArr(frParts) ? frParts : []) {
    const text = get(nested, "text");

    if (text !== undefined) {
      if (str(text).trim() !== "") nestedBlocks.push({ type: "text", text: str(text) });
      continue;
    }

    const inlineData = first(get(nested, "inlineData"), get(nested, "inline_data"));

    if (exists(inlineData)) {
      const block = contentPartFromInlineData(inlineData, isAssistant);

      if (block !== undefined) nestedBlocks.push(block);
      else if (!isAssistant) {
        if (droppedType === "") droppedType = "inlineData";
        drops.drop("inlineData");
      }

      continue;
    }

    const fileData = first(get(nested, "fileData"), get(nested, "file_data"));

    if (exists(fileData)) {
      const block = contentPartFromFileData(fileData);

      if (block !== undefined) nestedBlocks.push(block);
      else if (!isAssistant) {
        if (droppedType === "") droppedType = "fileData";
        drops.drop("fileData");
      }
    }
  }

  if (nestedBlocks.length > 0) {
    toolResult.content = [
      ...(hasBaseText ? [{ type: "text", text: baseText }] : []),
      ...nestedBlocks,
    ];

    return undefined;
  }

  if (onlyResult) toolResult.content = str(result);
  else if (exists(response)) toolResult.content = JSON.stringify(response);

  return droppedType !== "" && !hasBaseText ? droppedType : undefined;
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
