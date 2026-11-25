/**
 * OpenAI Responses client -> Claude Messages provider (request).
 *
 * Go source: internal/translator/claude/openai/responses/claude_openai-responses_request.go.
 *
 * The Codex `apply_patch` custom tool becomes a strict `{"input": ...}` function (`customToolToClaude`); the response
 * translator decodes it again. Signature compatibility uses `signature/provider.ts`. Go's log-only invariant
 * diagnostics are omitted.
 */
import { asBool, asInt, get, type Json, type JsonObject } from "@commissary/json";
import {
  applyTranslatedSummaryToClaude,
  convertLevelToBudget,
  hasLevel,
  mapToClaudeEffort,
} from "../../../../thinking/index.ts";
import {
  decodeBase64Raw,
  decodeBase64Std,
  decodeUtf8Strict,
} from "../../../../signature/base64.ts";
import { compatibleSignatureForProvider } from "../../../../signature/provider.ts";
import { lookupModelInfo } from "../../../model-info.ts";
import {
  applyPatchDescription,
  applyPatchParameters,
  isApplyPatchCustomTool,
} from "../../../common/apply-patch.ts";
import {
  attachCacheControl,
  isValidCacheControl,
  moveBlankPartCacheControl,
} from "../../../common/cache-control.ts";
import { applyClaudeStructuredOutput } from "../../../common/claude-system.ts";
import { deriveClaudeUserID } from "../../../common/claude-user-id.ts";
import {
  defaultClaudeMaxTokensForModel,
  normalizeClaudeToolInputSchema,
  sanitizeClaudeFunctionName,
} from "../../../common/claude-util.ts";
import { generateClaudeToolCallId } from "../../../common/request.ts";
import { sanitizeClaudeToolId } from "../../../common/tool-names.ts";
import { exists, isArr, isBlankText, isObj, isStr, str } from "../../../common/gjson.ts";
import { normalizeOpenAIFileData } from "../../../common/file-data.ts";
import { mimeTypeForExtension } from "../../../common/mime-types.ts";
import { isHttpUrl, UnsupportedPartError, UserTurnDrops } from "../../../common/parts.ts";
import {
  extractResponsesCallID,
  normalizeResponsesToolCallOutputs,
} from "../../../common/responses.ts";
import {
  clientToolSearchWins,
  ClaudeToolNames,
  CLAUDE_RESPONSES_REDACTED_THINKING_PREFIX,
  DISCOVERED_TOOL_PRIORITY,
  isUnsupportedOpenAIBuiltinToolType,
  qualifyResponsesNamespaceToolName,
  responsesToolDescriptors,
  responsesToolName,
  responsesToolNameMap,
  responsesToolWinners,
  type ToolDescriptor,
} from "./tools.ts";
import {
  deferredAnchorTool,
  stripClientToolSearch,
  toolSearchCallToClaude,
  toolSearchOutputContent,
  toolSearchOutputText,
  toolSearchToolToClaude,
} from "./tool-search.ts";
import {
  attachClaudeCitations,
  claudeBlocksHaveEmptyWebSearchResult,
  ResponsesWebSearchHistory,
  stripClaudeWebSearchCitations,
} from "./web-search.ts";
import type { TranslateRequestOptions } from "../../../registry.ts";

const first = (...values: Array<Json | undefined>): Json | undefined =>
  values.find((value) => value !== undefined);

/** `ConvertOpenAIResponsesRequestToClaude`. */
export const convertOpenAIResponsesRequestToClaude = (
  modelName: string,
  input: Json,
  stream: boolean,
  options?: TranslateRequestOptions,
): Json => convertRequest(modelName, input, stream, false, options);

/** `ConvertOpenAIResponsesRequestToClaudeWithCompat`. */
export const convertOpenAIResponsesRequestToClaudeWithCompat = (
  modelName: string,
  input: Json,
  stream: boolean,
  options?: TranslateRequestOptions,
): Json => convertRequest(modelName, input, stream, true, options);

type Message = JsonObject;

const convertRequest = (
  modelName: string,
  inputRoot: Json,
  stream: boolean,
  preserveEmptyThinkingBlocks: boolean,
  options: TranslateRequestOptions | undefined,
): Json => {
  // Go `topLevelSystemItemsFor` falls back to its legacy-model list; here the executor owns that list and an absent
  // option means every item stays top-level (OpenCode and the other callers outside the Claude executor).
  const topLevelSystemItems = options?.topLevelSystemItems !== false;
  const nativeToolSearch = options?.nativeToolSearch === true;
  // Without native tool search the client's `tool_search` is dropped: declarations and history items.
  const normalized = normalizeCodexAgentMessages(inputRoot);
  const root = nativeToolSearch ? normalized : stripClientToolSearch(normalized);
  const drops = new UserTurnDrops();
  // The first part type a tool output could not send (f08cb931); a refused user turn takes precedence over it.
  let toolOutputErr = "";

  const out: JsonObject = {
    model: "",
    max_tokens: defaultClaudeMaxTokensForModel(modelName),
    messages: [],
    metadata: { user_id: deriveClaudeUserID(root) },
  };

  const effortValue = get(root, "reasoning.effort");

  if (exists(effortValue)) {
    let effort = str(effortValue).trim().toLowerCase();

    if (effort !== "") {
      const mi = lookupModelInfo(modelName, "claude");
      const supportsAdaptive = (mi?.thinking?.levels?.length ?? 0) > 0;
      const supportsMax = supportsAdaptive && hasLevel(mi?.thinking?.levels, "max");

      const thinking = (): JsonObject => {
        const current = isObj(out.thinking) ? out.thinking : {};
        out.thinking = current;

        return current;
      };

      const dropEffort = (): void => {
        if (isObj(out.output_config)) delete out.output_config.effort;
      };

      if (supportsAdaptive) {
        if (effort === "none") {
          const t = thinking();
          t.type = "disabled";
          delete t.budget_tokens;
          dropEffort();
        } else if (effort === "auto") {
          const t = thinking();
          t.type = "adaptive";
          delete t.budget_tokens;
          dropEffort();
        } else {
          // A level the model advertises is sent as is; others are mapped to the nearest Claude effort.
          if (!hasLevel(mi?.thinking?.levels, effort))
            effort = mapToClaudeEffort(effort, supportsMax) ?? effort;
          const t = thinking();
          t.type = "adaptive";
          delete t.budget_tokens;
          const config = isObj(out.output_config) ? out.output_config : {};
          config.effort = effort;
          out.output_config = config;
        }
      } else {
        const budget = convertLevelToBudget(effort);

        if (budget !== undefined) {
          if (budget === 0) thinking().type = "disabled";
          else if (budget === -1) thinking().type = "enabled";
          else if (budget > 0) {
            const t = thinking();
            t.type = "enabled";
            t.budget_tokens = budget;
          }
        }
      }
    }
  }

  out.model = modelName;

  const mot = get(root, "max_output_tokens");

  if (exists(mot) && mot !== null) {
    let value = asInt(mot);
    const info = lookupModelInfo(modelName, "claude");
    const cap = info?.maxCompletionTokens ?? 0;

    if (cap > 0 && value > cap) value = cap;
    out.max_tokens = value;
  }

  out.stream = stream;

  if (get(root, "service_tier") === "priority") out.speed = "fast";

  // System-level inputs become top-level Claude system blocks in source order, except that, when the executor asks for
  // it, a text-only message item after the conversation started stays in place as a `role: "system"` turn right after
  // the next user message (it is queued until a user message is emitted).
  const systemBlocks: JsonObject[] = [];

  const instructions = get(root, "instructions");

  if (isStr(instructions)) pushSystemText(systemBlocks, instructions);
  const inputValue = get(root, "input");
  const systemEntries: SystemInputEntry[] = [];
  const systemEntryByItem = new Map<number, SystemInputEntry>();

  if (isArr(inputValue)) {
    let conversationStarted = false;

    for (const [itemIndex, item] of inputValue.entries()) {
      if (!isSystemLevelRole(str(get(item, "role")))) {
        conversationStarted = true;
        continue;
      }

      const blocks = systemItemBlocks(item);

      const entry: SystemInputEntry = {
        blocks,
        eligible:
          !topLevelSystemItems &&
          conversationStarted &&
          isMessageItem(item) &&
          blocks.length > 0 &&
          blocks.every((block) => str(block.type) === "text"),
        emitted: false,
      };

      systemEntries.push(entry);
      systemEntryByItem.set(itemIndex, entry);
    }
  }

  const names = ClaudeToolNames.build(root, nativeToolSearch);
  const winners = responsesToolWinners(root, nativeToolSearch);

  // Native tool search declares discovered tools as deferred and replays search results as tool_reference blocks. It
  // is off when a same-named user function owns the `tool_search` name.
  const nativeReferences =
    nativeToolSearch && clientToolSearchWins(responsesToolDescriptors(root, nativeToolSearch));

  let messageBlocks: Message[] = [];
  // Anthropic accepts a `role: "system"` turn only after a user message and before an assistant message or the end of
  // the messages: queued items go right after the next user message that is emitted.
  let pendingSystemEntries: SystemInputEntry[] = [];
  let pendingRole = "";
  let pendingParts: JsonObject[] = [];
  let pendingToolUseParts: JsonObject[] = [];
  // Claude response origin of the trailing thinking block in pendingParts (c71aa824).
  let pendingThinkingResponseID = "";
  let pendingThinkingBlockIndex = -1;

  // An assistant turn whose web search has no result: its citations would point at nothing (9acf81d3).
  let turnHasEmptyWebSearchResult = false;

  const endWebSearchTurn = (): void => {
    turnHasEmptyWebSearchResult = false;
  };

  const flushPendingMessage = (): void => {
    if (pendingRole === "") return;
    let parts = pendingParts;

    if (pendingRole === "assistant" && pendingToolUseParts.length > 0) {
      const combined = [...pendingParts];
      const separator = thinkingSeparatorForToolUse(pendingParts);

      if (separator !== undefined) combined.push(separator);
      combined.push(...pendingToolUseParts);
      parts = combined;
    }

    if (
      pendingRole === "assistant" &&
      (turnHasEmptyWebSearchResult || claudeBlocksHaveEmptyWebSearchResult(parts))
    ) {
      stripClaudeWebSearchCitations(parts);
    }

    if (parts.length > 0) {
      const msg: Message = { role: pendingRole, content: [] };
      msg.content = collapseSingleText(parts);
      messageBlocks.push(msg);

      if (pendingRole === "user") {
        for (const entry of pendingSystemEntries) {
          messageBlocks.push({ role: "system", content: entry.blocks });
          entry.emitted = true;
        }

        pendingSystemEntries = [];
      }
    }

    pendingRole = "";
    pendingParts = [];
    pendingToolUseParts = [];
    pendingThinkingResponseID = "";
    pendingThinkingBlockIndex = -1;
  };

  const appendParts = (role: string, parts: JsonObject[]): void => {
    if (role === "" || parts.length === 0) return;

    if (pendingRole !== "" && pendingRole !== role) flushPendingMessage();
    pendingRole = role;
    pendingParts.push(...parts);
    pendingThinkingResponseID = "";
    pendingThinkingBlockIndex = -1;
  };

  const appendToolUse = (toolUse: JsonObject): void => {
    if (pendingRole !== "" && pendingRole !== "assistant") flushPendingMessage();
    pendingRole = "assistant";
    pendingToolUseParts.push(toolUse);
  };

  const lastPendingIsThinking = (): boolean =>
    pendingParts.length > 0 && str(pendingParts[pendingParts.length - 1]?.type) === "thinking";

  const appendReasoning = (
    reasoningPart: JsonObject | undefined,
    origin: ClaudeReasoningItemOrigin,
  ): void => {
    if (reasoningPart === undefined) return;

    if (pendingRole !== "" && pendingRole !== "assistant") flushPendingMessage();
    pendingRole = "assistant";

    // A later reasoning item turns buffered client tool calls into a real separator between thinking blocks.
    if (pendingToolUseParts.length > 0) {
      pendingParts.push(...pendingToolUseParts);
      pendingToolUseParts = [];
      pendingThinkingResponseID = "";
      pendingThinkingBlockIndex = -1;
    }

    // Adjacent thinking blocks from different responses are rejected by Anthropic, so only the latest is kept. Blocks
    // from the same response in ascending block index order (a reasoning block then a progress-update block) are
    // replayed unchanged, as Anthropic requires (c71aa824).
    const isThinking = str(reasoningPart.type) === "thinking";
    const sameResponse = origin.ok && origin.responseID === pendingThinkingResponseID;

    if (isThinking) {
      if (
        sameResponse &&
        origin.blockIndex === pendingThinkingBlockIndex &&
        lastPendingIsThinking()
      ) {
        // Replaying the same trailing block index replaces only that block.
        pendingParts[pendingParts.length - 1] = reasoningPart;

        return;
      }

      if (!(sameResponse && origin.blockIndex > pendingThinkingBlockIndex)) {
        while (lastPendingIsThinking()) pendingParts.pop();
      }
    }

    pendingParts.push(reasoningPart);

    if (isThinking && origin.ok) {
      pendingThinkingResponseID = origin.responseID;
      pendingThinkingBlockIndex = origin.blockIndex;
    } else {
      pendingThinkingResponseID = "";
      pendingThinkingBlockIndex = -1;
    }
  };

  let inputItems: Json[] = [];

  if (exists(inputValue)) {
    if (isArr(inputValue)) inputItems = normalizeResponsesToolCallOutputs(inputValue);
    else if (isStr(inputValue) && !isBlankText(inputValue))
      appendParts("user", [{ type: "text", text: inputValue }]);
  }

  const lastToolResult = new Map<string, Json>();

  for (const item of inputItems) {
    const type = str(get(item, "type"));

    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const rawID = extractResponsesCallID(item);

      if (rawID !== "") lastToolResult.set(rawID, item);
    }
  }

  const emittedToolResults = new Set<string>();
  const emittedRawToolUses = new Set<string>();

  const webSearchHistory = new ResponsesWebSearchHistory(inputItems, options?.webSearchResults);

  for (const [itemIndex, item] of inputItems.entries()) {
    if (isSystemLevelRole(str(get(item, "role")))) {
      const entry = systemEntryByItem.get(itemIndex);

      if (entry?.eligible === true) pendingSystemEntries.push(entry);
      continue;
    }

    let typ = str(get(item, "type"));

    if (typ === "" && str(get(item, "role")) !== "") typ = "message";

    switch (typ) {
      case "message": {
        let role = "";
        const partsJSON: JsonObject[] = [];
        let droppedPartType = "";
        const parts = get(item, "content");

        if (isArr(parts)) {
          for (const part of parts) {
            const ptype = str(get(part, "type"));

            switch (ptype) {
              case "input_text":
              case "output_text": {
                const text = get(part, "text");

                if (exists(text)) {
                  if (isBlankText(str(text))) {
                    moveBlankPartCacheControl(partsJSON, 0, part);
                  } else {
                    const contentPart: JsonObject = { type: "text", text: str(text) };
                    attachClaudeCitations(contentPart, get(part, "annotations"));
                    attachCacheControl(contentPart, part);
                    partsJSON.push(contentPart);
                  }
                }

                role = ptype === "input_text" ? "user" : "assistant";
                break;
              }

              case "refusal": {
                const text = get(part, "refusal");

                if (exists(text)) {
                  if (isBlankText(str(text))) {
                    moveBlankPartCacheControl(partsJSON, 0, part);
                  } else {
                    const contentPart: JsonObject = { type: "text", text: str(text) };
                    attachCacheControl(contentPart, part);
                    partsJSON.push(contentPart);
                  }
                }

                role = "assistant";
                break;
              }

              case "input_image": {
                let url = str(get(part, "image_url"));

                if (url === "") url = str(get(part, "url"));

                if (url === "") break;
                const contentPart = imageBlock(url);

                if (contentPart !== undefined) {
                  attachCacheControl(contentPart, part);
                  partsJSON.push(contentPart);

                  if (role === "") role = "user";
                }

                break;
              }

              case "input_file": {
                const contentPart = responsesInputFileToClaude(part);

                if (contentPart !== undefined) {
                  attachCacheControl(contentPart, part);
                  partsJSON.push(contentPart);

                  if (role === "") role = "user";
                } else if (droppedPartType === "") droppedPartType = ptype;
                break;
              }

              case "input_audio":
                if (droppedPartType === "") droppedPartType = ptype;
                break;
            }
          }
        } else if (isStr(parts) && !isBlankText(parts)) {
          partsJSON.push({ type: "text", text: parts });
        }

        if (role === "") {
          const r = str(get(item, "role"));
          role = r === "user" || r === "assistant" ? r : "user";
        }

        if (role === "user") {
          if (droppedPartType !== "") drops.drop(droppedPartType);
          drops.endTurn(partsJSON.length);
        }

        if (partsJSON.length > 0) {
          // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
          const last = partsJSON[partsJSON.length - 1] as JsonObject;

          if (!exists(last.cache_control)) attachCacheControl(last, item);
          appendParts(role, partsJSON);

          if (role === "user") endWebSearchTurn();
        }

        break;
      }

      case "web_search_call": {
        const blocks = webSearchHistory.claudeBlocks(itemIndex, item);

        if (blocks.length > 0) {
          if (claudeBlocksHaveEmptyWebSearchResult(blocks)) turnHasEmptyWebSearchResult = true;
          appendParts("assistant", blocks);
        }

        break;
      }

      case "reasoning":
        appendReasoning(
          reasoningToClaudeThinking(item, preserveEmptyThinkingBlocks),
          parseClaudeReasoningItemID(str(get(item, "id"))),
        );
        break;
      case "function_call":
      case "custom_tool_call": {
        const rawCallID = extractResponsesCallID(item);
        let callID = rawCallID;

        if (callID === "") callID = generateClaudeToolCallId();
        callID = sanitizeClaudeToolId(callID);

        if (rawCallID !== "") emittedRawToolUses.add(rawCallID);
        let name = str(get(item, "name"));
        const namespaceName = str(get(item, "namespace")).trim();

        if (namespaceName !== "") name = qualifyResponsesNamespaceToolName(namespaceName, name);

        const toolUse: JsonObject = {
          type: "tool_use",
          id: callID,
          name: names.claudeName(name),
          input: {},
        };

        if (typ === "custom_tool_call") {
          toolUse.input = { input: str(get(item, "input")) };
        } else {
          const argsStr = str(get(item, "arguments"));

          if (argsStr !== "") {
            try {
              // SAFETY: JSON.parse can only produce JSON values, which is exactly what Json models.
              const parsed = JSON.parse(argsStr) as Json;

              if (isObj(parsed)) toolUse.input = parsed;
            } catch {
              // invalid arguments keep the empty object
            }
          }
        }

        appendToolUse(toolUse);
        break;
      }

      case "function_call_output":
      case "custom_tool_call_output": {
        const rawID = extractResponsesCallID(item);

        if (rawID !== "") {
          if (emittedToolResults.has(rawID)) break;
          emittedToolResults.add(rawID);
        }

        let outputItem = item;

        if (rawID !== "") outputItem = lastToolResult.get(rawID) ?? item;
        const output = get(outputItem, "output");

        // Outputs without a paired tool_use in this input would be orphan tool_results, which Claude rejects.
        if (rawID === "" || !emittedRawToolUses.has(rawID)) {
          const standalone = standaloneToolOutputToClaudeText(outputItem, output);

          if (standalone.unsupported !== "" && toolOutputErr === "")
            toolOutputErr = standalone.unsupported;
          appendParts("user", standalone.parts);
          endWebSearchTurn();
          break;
        }

        const toolResult: JsonObject = {
          type: "tool_result",
          tool_use_id: sanitizeClaudeToolId(rawID),
          content: "",
        };

        // Responses reports an unfinished tool output as status "incomplete"; Claude's only in-band equivalent is
        // is_error on the tool_result (upstream 59930ba3).
        if (str(get(outputItem, "status")).trim().toLowerCase() === "incomplete") {
          toolResult.is_error = true;
        }

        const applied = applyToolResultContent(toolResult, output);

        if (applied.unsupported !== "" && toolOutputErr === "") toolOutputErr = applied.unsupported;

        // Anthropic rejects cache_control inside tool_result.content, so the last valid part-level marker (or the
        // item's) goes on the outer tool_result block (8cab158f).
        if (!attachClaudeCacheControl(toolResult, applied.cacheSource))
          attachClaudeCacheControl(toolResult, outputItem);
        appendParts("user", [toolResult]);
        break;
      }

      case "tool_search_call": {
        if (!nativeToolSearch) break;
        const converted = toolSearchCallToClaude(item, names.claudeName("tool_search"));

        if (converted === undefined) break;
        emittedRawToolUses.add(converted.rawCallId);
        appendToolUse(converted.toolUse);
        break;
      }

      case "tool_search_output": {
        if (!nativeToolSearch) break;
        const rawID = str(get(item, "call_id")).trim();

        if (rawID !== "") {
          if (emittedToolResults.has(rawID)) break;
          emittedToolResults.add(rawID);
        }

        // An output without a paired search call would be an orphan tool_result, which Claude rejects.
        if (rawID === "" || !emittedRawToolUses.has(rawID)) {
          appendParts("user", [{ type: "text", text: toolSearchOutputText(item, names) }]);
          endWebSearchTurn();
          break;
        }

        appendParts("user", [
          {
            type: "tool_result",
            tool_use_id: sanitizeClaudeToolId(rawID),
            content: nativeReferences
              ? toolSearchOutputContent(item, names, winners)
              : toolSearchOutputText(item, names),
          },
        ]);
        break;
      }

      default:
        break;
    }
  }

  flushPendingMessage();

  // Every system-level item not emitted as an in-place turn (leading ones, ineligible ones and queued ones no user
  // message followed) becomes a top-level block in source order; the structured-output instruction stays last.
  for (const entry of systemEntries) if (!entry.emitted) systemBlocks.push(...entry.blocks);
  pendingSystemEntries = [];
  const formatResult = first(get(root, "text.format"), get(root, "response_format"));
  const formatInstruction = applyClaudeStructuredOutput(out, modelName, formatResult);

  if (formatInstruction !== "") pushSystemText(systemBlocks, formatInstruction);

  const hadMessages = messageBlocks.length > 0;

  if (!preserveEmptyThinkingBlocks) messageBlocks = stripTrailingThinkingBlocks(messageBlocks);
  messageBlocks = repairToolPairing(messageBlocks);

  if (!preserveEmptyThinkingBlocks)
    messageBlocks = dropUnsupportedAssistantPrefill(modelName, messageBlocks);

  if (messageBlocks.length === 0 && (systemBlocks.length > 0 || hadMessages)) {
    messageBlocks.push({ role: "user", content: [{ type: "text", text: "" }] });
  }

  out.messages = messageBlocks;

  if (systemBlocks.length > 0) out.system = systemBlocks;

  const includedToolNames = new Set<string>();
  const toolItems: JsonObject[] = [];
  // The deferred anchor goes between declared and discovered tools, so each discovery only appends to tools[].
  let anchorIndex = -1;

  for (const descriptor of responsesToolDescriptors(root, nativeToolSearch)) {
    const winner = winners.get(descriptor.name);

    if (winner === undefined || winner.order !== descriptor.order) continue;
    const claudeName = names.claudeName(descriptor.name);
    const converted = toolDescriptorToClaude(descriptor, claudeName);

    if (converted === undefined) continue;

    if (nativeReferences && descriptor.sourcePriority === DISCOVERED_TOOL_PRIORITY) {
      if (anchorIndex < 0) anchorIndex = toolItems.length;
      // Anthropic rejects cache_control on a deferred tool (400).
      delete converted.cache_control;
      converted.defer_loading = true;
    }

    const toolName = str(converted.name);

    if (toolName !== "") {
      includedToolNames.add(descriptor.name);
      includedToolNames.add(toolName);
    }

    toolItems.push(converted);
  }

  if (nativeReferences) {
    const anchor = deferredAnchorTool(toolItems);

    if (anchor !== undefined)
      toolItems.splice(anchorIndex < 0 ? toolItems.length : anchorIndex, 0, anchor);
  }

  const toolNameMap = responsesToolNameMap(root, includedToolNames, nativeToolSearch);

  if (toolItems.length > 0) out.tools = toolItems;

  const toolChoice = get(root, "tool_choice");
  let toolChoiceNone = false;
  let forcedToolFilteredOut = false;

  if (exists(toolChoice)) {
    if (isStr(toolChoice)) {
      if (toolChoice === "auto") out.tool_choice = { type: "auto" };
      else if (toolChoice === "none") toolChoiceNone = true;
      else if (toolChoice === "required") {
        if (includedToolNames.size > 0) out.tool_choice = { type: "any" };
        else forcedToolFilteredOut = true;
      }
    } else if (isObj(toolChoice) || isArr(toolChoice)) {
      const choiceType = str(get(toolChoice, "type")).trim();

      if (choiceType === "none") {
        toolChoiceNone = true;
      } else if (choiceType === "function" || choiceType === "custom") {
        let fn = str(get(toolChoice, "function.name"));

        if (fn === "") fn = str(get(toolChoice, "custom.name"));

        if (fn === "") fn = str(get(toolChoice, "name"));
        let namespaceName = str(get(toolChoice, "namespace"));

        if (namespaceName === "") namespaceName = str(get(toolChoice, "function.namespace"));

        if (namespaceName === "") namespaceName = str(get(toolChoice, "custom.namespace"));

        if (namespaceName !== "") fn = qualifyResponsesNamespaceToolName(namespaceName, fn);
        const mapped = toolNameMap.get(fn);

        if (mapped !== undefined && mapped !== "") fn = mapped;

        if (includedToolNames.has(fn))
          out.tool_choice = { name: names.claudeName(fn), type: "tool" };
        else forcedToolFilteredOut = true;
      } else if (choiceType !== "" && choiceType !== "auto" && !includedToolNames.has(choiceType)) {
        forcedToolFilteredOut = true;
      }
    }
  }

  // parallel_tool_calls=false maps to Anthropic's disable_parallel_tool_use, like the Chat Completions translator.
  // It is not added when the effective choice is none, when no tool survived conversion, or when a forced tool was
  // filtered out (no tool_choice was produced for it).
  if (
    get(root, "parallel_tool_calls") === false &&
    !toolChoiceNone &&
    !forcedToolFilteredOut &&
    toolItems.length > 0
  ) {
    const choice = out.tool_choice;

    if (isObj(choice)) {
      choice.disable_parallel_tool_use = true;
    } else {
      out.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
  }

  const result =
    applyTranslatedSummaryToClaude(out, root, "openai-response", modelName, lookupModelInfo) ?? out;

  const refusal = drops.err(result);

  if (refusal !== undefined) throw refusal;

  if (toolOutputErr !== "") throw new UnsupportedPartError(toolOutputErr, result);

  return result;
};

/** A single plain text block collapses to a string content. */
const collapseSingleText = (parts: JsonObject[]): Json => {
  if (parts.length === 1) {
    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    const part = parts[0] as JsonObject;

    if (str(part.type) === "text" && !exists(part.cache_control) && !exists(part.citations))
      return str(part.text);
  }

  return parts;
};

interface SystemInputEntry {
  readonly blocks: JsonObject[];
  /** May become an in-place `role: "system"` turn. */
  readonly eligible: boolean;
  emitted: boolean;
}

/** Only a message item can become a `role: "system"` turn. */
const isMessageItem = (item: Json): boolean => {
  const type = str(get(item, "type"));

  return type === "" || type === "message";
};

const pushSystemText = (target: JsonObject[], text: string, cacheSource?: Json): void => {
  if (isBlankText(text)) return;
  const block: JsonObject = { type: "text", text };

  if (cacheSource !== undefined) attachCacheControl(block, cacheSource);
  target.push(block);
};

/**
 * One system-level input item as Claude system blocks (`responsesSystemItemToClaudeBlocks`): a text block per non-blank
 * text part, a blank part's cache_control moved to the block before, the item's cache_control on its last block, and a
 * typed marker for each unsupported part so the executor can report it instead of dropping it.
 */
const systemItemBlocks = (item: Json): JsonObject[] => {
  const blocks: JsonObject[] = [];
  const content = get(item, "content");

  if (isStr(content)) pushSystemText(blocks, content);
  else if (isArr(content)) {
    for (const part of content) {
      switch (str(get(part, "type"))) {
        case "input_text":
        case "output_text":
        case "text": {
          const text = str(get(part, "text"));

          // A blank part is dropped (Anthropic answers 400 to it); its cache_control moves to the block before.
          if (isBlankText(text)) moveBlankPartCacheControl(blocks, 0, part);
          else pushSystemText(blocks, text, part);
          break;
        }

        default: {
          const block = systemUnsupportedBlock(part);

          if (block !== undefined) blocks.push(block);
        }
      }
    }
  }

  if (exists(get(item, "cache_control")) && blocks.length > 0) {
    // SAFETY: `blocks` is non-empty (checked above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    const last = blocks[blocks.length - 1] as JsonObject;

    if (!exists(last.cache_control)) attachCacheControl(last, item);
  }

  return blocks;
};

const isSystemLevelRole = (role: string): boolean => {
  const normalized = role.trim().toLowerCase();

  return normalized === "system" || normalized === "developer";
};

type ParseDataUrlResult = { mediaType: string; data: string };

const parseDataUrl = (url: string): ParseDataUrlResult => {
  const trimmed = url.slice("data:".length);
  const at = trimmed.indexOf(";base64,");
  let mediaType = "application/octet-stream";
  let data = "";

  if (at >= 0) {
    if (at > 0) mediaType = trimmed.slice(0, at);
    data = trimmed.slice(at + ";base64,".length);
  }

  return { mediaType, data };
};

const imageBlock = (url: string): JsonObject | undefined => {
  if (url.startsWith("data:")) {
    const { mediaType, data } = parseDataUrl(url);

    return data === ""
      ? undefined
      : { type: "image", source: { type: "base64", media_type: mediaType, data } };
  }

  return { type: "image", source: { type: "url", url } };
};

const systemUnsupportedBlock = (part: Json | undefined): JsonObject | undefined => {
  const type = str(get(part, "type")).trim();

  return type === "" ? undefined : { type };
};

const dropUnsupportedAssistantPrefill = (modelName: string, messages: Message[]): Message[] => {
  if (!modelRejectsAssistantPrefill(modelName) || messages.length === 0) return messages;
  // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
  const last = messages[messages.length - 1] as Message;

  if (str(last.role).trim().toLowerCase() !== "assistant") return messages;

  // A turn that ends on a server-tool block was paused by pause_turn: the continuation sends it back unchanged.
  if (endsWithPausedServerTool(last)) return messages;

  return messages.slice(0, -1);
};

const endsWithPausedServerTool = (message: Message): boolean => {
  const content = message.content;

  if (!isArr(content) || content.length === 0) return false;

  const type = str(get(content[content.length - 1], "type"))
    .trim()
    .toLowerCase();

  return type === "server_tool_use" || type === "web_search_tool_result";
};

const stripTrailingThinkingBlocks = (messages: Message[]): Message[] => {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
  const last = messages[lastIdx] as Message;

  if (str(last.role).trim().toLowerCase() !== "assistant") return messages;
  const content = last.content;

  if (!isArr(content)) return messages;
  let end = content.length;

  while (end > 0) {
    const type = str(get(content[end - 1], "type")).trim();

    if (type === "thinking" || type === "redacted_thinking") end--;
    else break;
  }

  if (end === content.length) return messages;

  if (end === 0) return messages.slice(0, lastIdx);
  // SAFETY: only the elements before `end` are kept; the slice of a JsonObject[] list stays JsonObject[].
  const remaining = content.slice(0, end) as JsonObject[];
  messages[lastIdx] = { ...last, content: collapseSingleText(remaining) };

  return messages;
};

const modelRejectsAssistantPrefill = (modelName: string): boolean => {
  let normalized = modelName.trim().toLowerCase();
  const slash = normalized.lastIndexOf("/");

  if (slash >= 0) normalized = normalized.slice(slash + 1);

  if (normalized.startsWith("claude-")) normalized = normalized.slice("claude-".length);
  const tokens = normalized.replaceAll(".", "-").split("-");

  if (tokens[0] === "fable") return true;

  if (
    tokens.length < 2 ||
    (tokens[0] !== "opus" && tokens[0] !== "sonnet" && tokens[0] !== "haiku")
  )
    return false;

  const parseVersion = (token: string | undefined): number => {
    // Eight-digit snapshot dates must never be treated as versions.
    if (token === undefined || token === "" || token.length >= 8 || !/^\d+$/u.test(token))
      return -1;

    return Number.parseInt(token, 10);
  };

  const major = parseVersion(tokens[1]);

  if (major >= 5) return true;

  return tokens[0] === "sonnet" && major === 4 && tokens.length > 2 && parseVersion(tokens[2]) >= 6;
};

/**
 * Rebuilds one Claude thinking block from a Responses reasoning item. Anthropic requires a signature on every
 * thinking block, so an item whose encrypted_content is missing or foreign is dropped unless compat mode keeps it.
 */
const reasoningToClaudeThinking = (item: Json, preserveEmpty: boolean): JsonObject | undefined => {
  const encrypted = str(get(item, "encrypted_content"));
  const trimmed = encrypted.trim();

  if (trimmed.startsWith(CLAUDE_RESPONSES_REDACTED_THINKING_PREFIX)) {
    const data = trimmed.slice(CLAUDE_RESPONSES_REDACTED_THINKING_PREFIX.length).trim();

    return data === "" ? undefined : { type: "redacted_thinking", data };
  }

  let signature: string;
  const compatible = compatibleSignatureForProvider("claude", encrypted);

  if (compatible !== undefined) signature = compatible;
  else if (preserveEmpty) signature = encrypted;
  else return undefined;

  return { type: "thinking", thinking: reasoningText(item), signature };
};

/** A Responses reasoning item's Claude response ID and content block index. */
export interface ClaudeReasoningItemOrigin {
  readonly responseID: string;
  readonly blockIndex: number;
  readonly ok: boolean;
}

/**
 * `parseClaudeReasoningItemID` (c71aa824): the Claude response ID and content block index of a reasoning item ID
 * `rs_<response id>_<block index>`, as the Claude -> Responses translator names them; other IDs are not ok.
 */
export const parseClaudeReasoningItemID = (itemID: string): ClaudeReasoningItemOrigin => {
  const none: ClaudeReasoningItemOrigin = { responseID: "", blockIndex: -1, ok: false };

  if (!itemID.startsWith("rs_")) return none;
  const rest = itemID.slice(3);
  const sep = rest.lastIndexOf("_");

  if (sep <= 0) return none;
  const responseID = rest.slice(0, sep);
  const indexStr = rest.slice(sep + 1);

  if (responseID.trim() === "" || !/^[0-9]+$/u.test(indexStr)) return none;
  const blockIndex = Number.parseInt(indexStr, 10);

  return Number.isSafeInteger(blockIndex) ? { responseID, blockIndex, ok: true } : none;
};

const reasoningText = (item: Json): string => {
  const summary = reasoningPartsText(get(item, "summary"));

  return summary !== "" ? summary : reasoningPartsText(get(item, "content"));
};

const reasoningPartsText = (parts: Json | undefined): string => {
  if (!isArr(parts)) return "";
  let out = "";

  for (const part of parts) {
    const text = get(part, "text");

    if (exists(text)) out += str(text);
    else if (isStr(part)) out += part;
  }

  return out;
};

const thinkingSeparatorForToolUse = (parts: JsonObject[]): JsonObject | undefined => {
  if (parts.length === 0) return undefined;

  // SAFETY: `parts.length === 0` returned above, so the last index is in bounds; the cast only drops the `undefined` added by noUncheckedIndexedAccess.
  if (str((parts[parts.length - 1] as JsonObject).type) !== "web_search_tool_result")
    return undefined;

  for (let index = parts.length - 1; index >= 0; index--) {
    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    if (str((parts[index] as JsonObject).type) === "thinking") return parts[index];
  }

  return undefined;
};

/** `hasValidClaudeCacheControl`. */
const hasValidClaudeCacheControl = (src: Json | undefined): boolean =>
  isValidCacheControl(get(src, "cache_control"));

/**
 * `attachClaudeCacheControlDoc`: copies a valid `cache_control` from `src` onto `block` unless the block cannot host
 * one (thinking, or blank text); reports whether it was attached.
 */
const attachClaudeCacheControl = (block: JsonObject, src: Json | undefined): boolean => {
  if (!hasValidClaudeCacheControl(src)) return false;

  switch (str(block.type)) {
    case "thinking":
    case "redacted_thinking":
      return false;
    case "text":
      if (isBlankText(str(block.text))) return false;
  }

  attachCacheControl(block, src);

  return true;
};

/** `isResponsesStructuredToolOutputPart`: a single tool output object that is a content part, not a domain value. */
const isResponsesStructuredToolOutputPart = (part: Json | undefined): boolean => {
  if (!isObj(part)) return false;

  switch (str(part.type).trim().toLowerCase()) {
    case "input_text":
    case "output_text":
    case "input_image":
    case "input_file":
    case "file":
    case "input_audio":
    case "audio":
    case "input_video":
    case "video":
      return true;
    case "text":
      return isStr(part.text);
    default:
      return false;
  }
};

/** `unsupportedResponsesToolPartType`: the type of a media part Claude cannot take, `""` otherwise. */
const unsupportedResponsesToolPartType = (part: Json | undefined): string => {
  const ptype = str(get(part, "type")).trim();

  switch (ptype.toLowerCase()) {
    case "input_file":
    case "file":
    case "input_audio":
    case "audio":
    case "input_video":
    case "video":
    case "input_image":
      return ptype;
    default:
      return "";
  }
};

/** `responsesToolOutputItems`: an output array's items, or a single structured part as one item. */
const responsesToolOutputItems = (output: Json | undefined): Json[] | undefined => {
  if (output === undefined) return undefined;

  if (isArr(output)) return output;

  return isResponsesStructuredToolOutputPart(output) ? [output] : undefined;
};

interface ToolResultContent {
  /** The last converted part with a valid cache_control, to hoist onto the tool_result (8cab158f). */
  readonly cacheSource: Json | undefined;
  /** The first media part type Claude cannot take, `""` when none (f08cb931). */
  readonly unsupported: string;
}

/** `applyResponsesToolResultContentDoc`. */
const applyToolResultContent = (
  toolResult: JsonObject,
  output: Json | undefined,
): ToolResultContent => {
  const items = responsesToolOutputItems(output);

  if (items !== undefined) {
    const partsJSON: JsonObject[] = [];
    let hasImage = false;
    let hasFile = false;
    let droppedBlankPart = false;
    let unsupported = "";
    let cacheSource: Json | undefined;

    for (const part of items) {
      const converted = contentPartToClaude(part);

      if (converted === undefined) {
        if (unsupported === "") unsupported = unsupportedResponsesToolPartType(part);
        continue;
      }

      if (hasValidClaudeCacheControl(part)) cacheSource = part;

      if (!contentPartHasVisibleContent(converted)) {
        droppedBlankPart = true;
        continue;
      }

      partsJSON.push(converted);

      if (converted.type === "image") hasImage = true;

      if (converted.type === "document") hasFile = true;
    }

    if (unsupported !== "") return { cacheSource: undefined, unsupported };

    if (partsJSON.length === 0) {
      toolResult.content = droppedBlankPart ? "" : str(output);

      return { cacheSource, unsupported: "" };
    }

    if (partsJSON.length === 1 && !hasImage && !hasFile) {
      // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      const textPart = partsJSON[0] as JsonObject;

      if (textPart.type === "text") {
        toolResult.content = str(textPart.text);

        return { cacheSource, unsupported: "" };
      }
    }

    delete toolResult.content;
    toolResult.content = partsJSON;

    return { cacheSource, unsupported: "" };
  }

  toolResult.content = str(output);

  return { cacheSource: undefined, unsupported: "" };
};

const contentPartHasVisibleContent = (part: Json): boolean =>
  str(get(part, "type")) !== "text" || str(get(part, "text")).trim() !== "";

/**
 * `convertResponsesStandaloneToolOutputToClaudeText`: a tool output with no matching tool_use as ordinary user
 * content blocks, keeping the item's and its parts' cache_control (8cab158f).
 */
interface StandaloneToolOutput {
  readonly parts: JsonObject[];
  /** The first media part type Claude cannot take, `""` when none (f08cb931). */
  readonly unsupported: string;
}

const standaloneToolOutputToClaudeText = (
  outputItem: Json | undefined,
  output: Json | undefined,
): StandaloneToolOutput => {
  let droppedPartCacheSource: Json | undefined;
  const items = responsesToolOutputItems(output);

  if (items !== undefined) {
    const partsJSON: JsonObject[] = [];
    let unsupported = "";

    for (const part of items) {
      const converted = contentPartToClaude(part);

      if (converted === undefined) {
        if (unsupported === "") unsupported = unsupportedResponsesToolPartType(part);
        continue;
      }

      // Empty text parts are dropped so a mixed array never emits blocks Anthropic rejects; their cache_control
      // moves to the block before (or to the placeholder when none is left).
      if (!contentPartHasVisibleContent(converted)) {
        const previous = partsJSON[partsJSON.length - 1];

        if (previous !== undefined) {
          if (!exists(previous.cache_control)) attachClaudeCacheControl(previous, part);
        } else if (hasValidClaudeCacheControl(part)) {
          droppedPartCacheSource = part;
        }

        continue;
      }

      attachClaudeCacheControl(converted, part);
      partsJSON.push(converted);
    }

    if (unsupported !== "") return { parts: [], unsupported };

    const last = partsJSON[partsJSON.length - 1];

    if (last !== undefined) {
      if (!exists(last.cache_control)) attachClaudeCacheControl(last, outputItem);

      return { parts: partsJSON, unsupported: "" };
    }
  }

  const text = str(output);

  // An empty standalone output still needs a block so the user message it joins never ends up empty; the array
  // guard keeps the raw array dump out when every converted part was empty.
  if (isArr(output) || isResponsesStructuredToolOutputPart(output) || text.trim() === "") {
    const placeholder: JsonObject = { type: "text", text: "Tool result was empty." };

    if (!attachClaudeCacheControl(placeholder, droppedPartCacheSource))
      attachClaudeCacheControl(placeholder, outputItem);

    return { parts: [placeholder], unsupported: "" };
  }

  const block: JsonObject = { type: "text", text };
  attachClaudeCacheControl(block, outputItem);

  return { parts: [block], unsupported: "" };
};

/** `convertResponsesContentPartToClaude`. */
const contentPartToClaude = (part: Json | undefined): JsonObject | undefined => {
  switch (str(get(part, "type"))) {
    case "input_text":
    case "output_text":
    case "text": {
      const text = get(part, "text");

      return exists(text) ? { type: "text", text: str(text) } : undefined;
    }

    case "input_image": {
      let url = str(get(part, "image_url"));

      if (url === "") url = str(get(part, "url"));

      return url === "" ? undefined : imageBlock(url);
    }

    case "input_file":
    case "file":
      return responsesInputFileToClaude(part);
  }

  return undefined;
};

/** `isGenericClaudeInputFileMIME`. */
const isGenericClaudeInputFileMIME = (mimeType: string): boolean => {
  const m = mimeType.trim().toLowerCase();

  return m === "" || m === "application/octet-stream" || m === "binary/octet-stream";
};

/** `isSupportedClaudeDocumentMIME`: Claude documents take PDF and plain text only. */
const isSupportedClaudeDocumentMIME = (mimeType: string): boolean => {
  const m = mimeType.trim().toLowerCase();

  return m === "application/pdf" || m === "text/plain";
};

/** `filepath.Ext` without the dot, lower-cased. */
const fileExtension = (filename: string): string => {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
};

/** `resolveClaudeInputFileFallbackMIME`: an explicit MIME type or format, else the filename's extension. */
const resolveClaudeInputFileFallbackMIME = (part: Json | undefined, filename: string): string => {
  for (const path of ["mime_type", "file.mime_type", "format", "file.format"]) {
    const candidate = str(get(part, path)).trim();

    if (candidate === "" || isGenericClaudeInputFileMIME(candidate)) continue;

    if (candidate.includes("/")) return candidate;
    const ext = candidate.toLowerCase();
    const mapped = mimeTypeForExtension(ext.startsWith(".") ? ext.slice(1) : ext);

    if (mapped !== "" && !isGenericClaudeInputFileMIME(mapped)) return mapped;
  }

  if (filename !== "") {
    const mapped = mimeTypeForExtension(fileExtension(filename));

    if (mapped !== "" && !isGenericClaudeInputFileMIME(mapped)) return mapped;
  }

  return "";
};

/** `base64.StdEncoding`, then `RawStdEncoding`, decoded as valid non-empty UTF-8. */
const decodeBase64Text = (data: string): string | undefined => {
  const bytes = decodeBase64Std(data) ?? decodeBase64Raw(data);

  if (bytes === undefined || bytes.length === 0) return undefined;

  return decodeUtf8Strict(bytes);
};

/**
 * `convertResponsesInputFileToClaude` (f08cb931): base64 file data becomes a PDF or plain-text document (its MIME type
 * from the data URL, the part's MIME type or format, the filename, or a `%PDF-` prefix), an http(s) `file_url` a URL
 * document; anything else (other binary types, other URLs) is `undefined`.
 */
const responsesInputFileToClaude = (part: Json | undefined): JsonObject | undefined => {
  const field = (key: string): string => {
    const direct = str(get(part, key)).trim();

    return direct !== "" ? direct : str(get(part, `file.${key}`)).trim();
  };

  const filename = field("filename");
  let fileData = field("file_data");
  let fileURL = field("file_url");

  if (fileData === "" && fileURL.slice(0, 5).toLowerCase() === "data:") {
    fileData = fileURL;
    fileURL = "";
  }

  const fallbackMIME = resolveClaudeInputFileFallbackMIME(part, filename);

  if (fileData !== "") {
    let mediaType: string;
    let data: string;

    if (fileData.slice(0, 5).toLowerCase() === "data:") {
      const rest = fileData.slice(5);
      const comma = rest.indexOf(",");

      if (comma < 0) return undefined;
      const payload = rest.slice(comma + 1).trim();

      if (payload === "") return undefined;
      const fields = rest.slice(0, comma).split(";");

      if (!fields.slice(1).some((f) => f.trim().toLowerCase() === "base64")) return undefined;
      mediaType = (fields[0] ?? "").trim();
      data = payload;
    } else {
      const normalized = normalizeOpenAIFileData(filename, fallbackMIME, fileData);

      mediaType = normalized?.mimeType ?? fallbackMIME;
      data = normalized?.data ?? fileData;
    }

    if (isGenericClaudeInputFileMIME(mediaType)) {
      if (fallbackMIME !== "") mediaType = fallbackMIME;
      else if (data.startsWith("JVBERi0")) mediaType = "application/pdf";
    }

    if (!isSupportedClaudeDocumentMIME(mediaType) || data === "") return undefined;
    const normalizedMIME = mediaType.trim().toLowerCase();

    if (normalizedMIME === "text/plain") {
      const decoded = decodeBase64Text(data);

      return decoded === undefined || decoded === ""
        ? undefined
        : { type: "document", source: { type: "text", media_type: "text/plain", data: decoded } };
    }

    return { type: "document", source: { type: "base64", media_type: normalizedMIME, data } };
  }

  return isHttpUrl(fileURL)
    ? { type: "document", source: { type: "url", url: fileURL } }
    : undefined;
};

const toolDescriptorToClaude = (
  descriptor: ToolDescriptor,
  claudeName: string,
): JsonObject | undefined => {
  let overrideName = claudeName;

  if (overrideName === "" && !descriptor.direct) overrideName = descriptor.name;

  if (descriptor.clientSearch) return toolSearchToolToClaude(descriptor.tool, claudeName);

  switch (descriptor.toolType) {
    case "function":
      return functionToolToClaude(descriptor.tool, overrideName);
    case "custom":
      return customToolToClaude(descriptor.tool, overrideName);
    case "web_search":
      return webSearchToolToClaude(descriptor.tool);
    default:
      if (isUnsupportedOpenAIBuiltinToolType(descriptor.toolType)) return undefined;

      if (str(get(descriptor.tool, "name")) === "") return undefined;

      return isObj(descriptor.tool) ? descriptor.tool : undefined;
  }
};

const toolDescription = (tool: Json): string => {
  const description = str(get(tool, "description"));

  return description !== "" ? description : str(get(tool, "function.description"));
};

const toolParameters = (tool: Json): Json | undefined => {
  for (const path of [
    "parameters",
    "parametersJsonSchema",
    "input_schema",
    "function.parameters",
    "function.parametersJsonSchema",
  ]) {
    const parameters = get(tool, path);

    if (exists(parameters)) return parameters;
  }

  return undefined;
};

const functionToolToClaude = (tool: Json, overrideName: string): JsonObject | undefined => {
  let name = overrideName.trim();

  if (name === "") name = sanitizeClaudeFunctionName(responsesToolName(tool));

  if (name === "") return undefined;

  const out: JsonObject = {
    name,
    description: "",
    input_schema: { type: "object", properties: {} },
  };

  const description = toolDescription(tool);

  if (description !== "") out.description = description;
  out.input_schema = normalizeClaudeToolInputSchema(toolParameters(tool));
  attachCacheControl(out, tool);

  if (!exists(out.cache_control)) attachCacheControl(out, get(tool, "function"));

  return out;
};

const customToolToClaude = (tool: Json, overrideName: string): JsonObject | undefined => {
  let name = overrideName.trim();

  if (name === "") name = sanitizeClaudeFunctionName(responsesToolName(tool));

  if (name === "") return undefined;

  const out: JsonObject = {
    name,
    description: "",
    input_schema: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
  };

  const description = toolDescription(tool);

  if (description !== "") out.description = description;

  if (isApplyPatchCustomTool(tool)) {
    // The Codex freeform patch grammar becomes a strict `{"input": ...}` function (decoded again in the response).
    out.description = applyPatchDescription(tool);
    out.input_schema = applyPatchParameters();
  }

  attachCacheControl(out, tool);

  return out;
};

const webSearchToolToClaude = (tool: Json): JsonObject | undefined => {
  const external = get(tool, "external_web_access");

  if (exists(external) && !asBool(external)) return undefined;
  let name = str(get(tool, "name")).trim();

  if (name === "") name = "web_search";
  const out: JsonObject = { type: "web_search_20250305", name };
  const maxUses = get(tool, "max_uses");

  if (exists(maxUses)) out.max_uses = asInt(maxUses);
  const allowedDomains = get(tool, "filters.allowed_domains");

  if (isArr(allowedDomains)) out.allowed_domains = allowedDomains;
  const userLocation = get(tool, "user_location");

  if (isObj(userLocation)) out.user_location = userLocation;

  return out;
};

// --- tool_use / tool_result pairing repair -------------------------------------------------------------------------

/**
 * Enforces the Anthropic invariant that every assistant tool_use is answered by a tool_result at the start of the
 * next user message and every tool_result references a tool_use in the preceding assistant message. Missing results
 * are synthesised as errors and orphan results fold into plain text.
 */
const repairToolPairing = (messages: Message[]): Message[] => {
  if (messages.length === 0) return messages;
  let prevToolUseIDs = new Set<string>();
  const out: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
    let msg = messages[i] as Message;
    const role = str(msg.role);

    if (role === "user") {
      const [rebuilt, changed] = normalizeToolResultMessage(msg, prevToolUseIDs);

      if (changed) {
        msg = rebuilt;
        messages[i] = msg;
      }
    }

    out.push(msg);

    prevToolUseIDs = new Set<string>();

    if (role !== "assistant") continue;
    const toolUseIDs: string[] = [];
    const content = msg.content;

    if (isArr(content)) {
      for (const block of content) {
        if (str(get(block, "type")) === "tool_use") {
          const id = str(get(block, "id"));

          if (id !== "") {
            toolUseIDs.push(id);
            prevToolUseIDs.add(id);
          }
        }
      }
    }

    if (toolUseIDs.length === 0) continue;

    const next = messages[i + 1];
    const hasNextUser = next !== undefined && str(next.role) === "user";
    const answered = new Set<string>();

    if (hasNextUser && isArr(next.content)) {
      for (const block of next.content) {
        if (str(get(block, "type")) === "tool_result") answered.add(str(get(block, "tool_use_id")));
      }
    }

    const synthesized: JsonObject[] = [];

    for (const id of toolUseIDs) {
      if (answered.has(id)) continue;
      synthesized.push({
        type: "tool_result",
        tool_use_id: id,
        is_error: true,
        content: "Tool call was interrupted before any output was recorded.",
      });
    }

    if (synthesized.length === 0) continue;

    if (hasNextUser) {
      const parts: Json[] = [...synthesized];
      const nextContent = next.content;

      if (isArr(nextContent)) parts.push(...nextContent);
      else if (isStr(nextContent)) parts.push({ type: "text", text: nextContent });
      messages[i + 1] = { role: "user", content: parts };
    } else {
      out.push({ role: "user", content: synthesized });
    }
  }

  return out;
};

const normalizeToolResultMessage = (
  msg: Message,
  answeredIDs: ReadonlySet<string>,
): [Message, boolean] => {
  const content = msg.content;

  if (!isArr(content)) return [msg, false];
  const resultParts: Json[] = [];
  const otherParts: Json[] = [];
  let seenOther = false;
  let changed = false;

  for (const block of content) {
    if (str(get(block, "type")) === "tool_result") {
      if (!answeredIDs.has(str(get(block, "tool_use_id")))) {
        changed = true;
        seenOther = true;
        let foldedParts = toolResultTextParts(block);

        // An empty orphan result folds to nothing, so an explicit marker keeps the user message non-empty.
        if (foldedParts.length === 0)
          foldedParts = [{ type: "text", text: "Tool result was empty." }];

        // The folded block keeps the orphan's cache_control on its last part (8cab158f).
        const last = foldedParts[foldedParts.length - 1];

        if (exists(get(block, "cache_control")) && isObj(last) && !exists(last.cache_control)) {
          const copy: JsonObject = { ...last };

          if (attachClaudeCacheControl(copy, block)) foldedParts[foldedParts.length - 1] = copy;
        }

        otherParts.push(...foldedParts);
        continue;
      }

      resultParts.push(block);

      if (seenOther) changed = true;
      continue;
    }

    seenOther = true;
    otherParts.push(block);
  }

  if (!changed) return [msg, false];

  return [{ role: "user", content: [...resultParts, ...otherParts] }, true];
};

/** Folds an orphan tool_result block into plain text parts (empty text parts are filtered out). */
const toolResultTextParts = (block: Json): Json[] => {
  const content = get(block, "content");

  if (isArr(content)) {
    const parts: Json[] = [];

    for (const part of content) {
      let raw: Json = part;

      if (str(get(part, "type")) === "" && isObj(part)) raw = { ...part, type: "text" };

      if (!contentPartHasVisibleContent(raw)) continue;
      parts.push(raw);
    }

    return parts;
  }

  const text = str(content);

  return text.trim() === "" ? [] : [{ type: "text", text }];
};

/**
 * `normalizeCodexAgentMessages`: Codex multi-agent `agent_message` items become plain user messages; encrypted
 * content parts are surfaced as input_text.
 */
const normalizeCodexAgentMessages = (root: Json): Json => {
  const input = get(root, "input");

  if (!isArr(input) || !isObj(root)) return root;

  if (!input.some((item) => str(get(item, "type")).trim() === "agent_message")) return root;
  const updated = structuredClone(root);

  for (const item of isArr(updated.input) ? updated.input : []) {
    if (!isObj(item) || str(item.type).trim() !== "agent_message") continue;

    if (isArr(item.content)) {
      for (const part of item.content) {
        if (
          !isObj(part) ||
          str(part.type).trim() !== "encrypted_content" ||
          typeof part.encrypted_content !== "string"
        )
          continue;
        const text = part.encrypted_content;
        part.type = "input_text";
        part.text = text;
        delete part.encrypted_content;
      }
    }

    item.role = "user";
    item.type = "message";
  }

  return updated;
};
