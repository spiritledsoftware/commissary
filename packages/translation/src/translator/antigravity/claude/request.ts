/**
 * Claude Messages client -> Antigravity provider (request).
 *
 * Go source: internal/translator/antigravity/claude/antigravity_claude_request.go (+ web_search.go). Thinking
 * signatures follow the Antigravity "cache mode" (signature cache, `signature/cache.ts`) or "bypass mode" (client
 * signatures validated and normalised); Gemini models receive provider-native signatures through the carrier
 * envelopes of `carrier.ts`.
 */
import {
  asFloat,
  asInt,
  asString,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { compatibleAntigravityClaudeThinkingSignature } from "../../../signature/claude.ts";
import {
  getCachedSignature,
  hasValidSignature,
  signatureCacheEnabled,
} from "../../../signature/cache.ts";
import {
  compatibleSignatureForProvider,
  type SignatureBlockKind,
  type SignatureProvider,
  signatureProviderFromModelName,
} from "../../../signature/provider.ts";
import { getThinkingText } from "../../../thinking/index.ts";
import {
  alignClaudeToolResults,
  claudeMessageSystemReminderText,
} from "../../common/claude-messages.ts";
import { countSendableGeminiParts, UserTurnDrops } from "../../common/parts.ts";
import {
  mergeAdjacentGeminiContents,
  mergeAdjacentGeminiUserContents,
  setGeminiFunctionResponseRaw,
  setGeminiFunctionResponseResult,
  splitGeminiFunctionResponseTurns,
} from "../../gemini/common/contents.ts";
import { attachDefaultSafetySettings } from "../../gemini/common/safety.ts";
import {
  GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR,
  sanitizeGeminiRequestThoughtSignatures,
} from "../../gemini/common/signature.ts";
import { isClaudeCodeAttributionSystemText } from "../../common/claude-messages.ts";
import { cleanJsonSchemaForAntigravity } from "../../gemini/util/json-schema.ts";
import { mapSanitizedFunctionName, sanitizedFunctionNameMap } from "../../common/tool-names.ts";
import { deduplicateFunctionDeclarations } from "../openai/chat-request.ts";
import {
  buildAntigravityWebSearchRequest,
  isClaudeTypedWebSearchToolType,
  shouldBuildAntigravityWebSearchRequest,
} from "./web-search.ts";
import {
  carrierMatchesAdjacent,
  CarrierDirection,
  CarrierKind,
  decodeGeminiClaudeCarrierSignature,
  normalizeClaudeBypassSignature,
} from "./carrier.ts";

/** `resolveProviderCompatibleSignature`. */
const resolveProviderCompatibleSignature = (
  target: SignatureProvider,
  rawSignature: string,
  blockKind: SignatureBlockKind,
): string => {
  if (rawSignature === "") return "";

  if (target === "claude") return compatibleAntigravityClaudeThinkingSignature(rawSignature) ?? "";

  return compatibleSignatureForProvider(target, rawSignature, blockKind) ?? "";
};

/** `resolveCacheModeSignatureRequired`. */
const resolveCacheModeSignature = (
  modelName: string,
  thinkingText: string,
  rawSignature: string,
): string => {
  const target = signatureProviderFromModelName(modelName);

  // A client-carried signature that is incompatible never falls back to the recovery cache.
  if (rawSignature !== "")
    return resolveProviderCompatibleSignature(target, rawSignature, "unknown");

  if (thinkingText !== "") {
    const cached = getCachedSignature(modelName, thinkingText);

    if (cached !== "") {
      if (target === "claude") return compatibleAntigravityClaudeThinkingSignature(cached) ?? "";

      return cached;
    }
  }

  return "";
};

/** `resolveBypassModeSignatureForProvider`. */
const resolveBypassModeSignature = (target: SignatureProvider, rawSignature: string): string => {
  if (rawSignature === "") return "";

  if (target !== "claude" && target !== "unknown") return "";

  if (target === "claude") return compatibleAntigravityClaudeThinkingSignature(rawSignature) ?? "";

  try {
    return normalizeClaudeBypassSignature(rawSignature);
  } catch {
    return "";
  }
};

/** `resolveThinkingSignature`. */
const resolveThinkingSignature = (
  modelName: string,
  thinkingText: string,
  rawSignature: string,
): string => {
  const target = signatureProviderFromModelName(modelName);

  if (target === "gemini") {
    const carrier = decodeGeminiClaudeCarrierSignature(rawSignature);

    if (!carrier.ok) return "";

    const blockKind: SignatureBlockKind =
      carrier.marked && carrier.targetKind === CarrierKind.Function
        ? "gemini_function_call"
        : "gemini_model_part";

    return resolveProviderCompatibleSignature(target, carrier.signature, blockKind);
  }

  if (signatureCacheEnabled())
    return resolveCacheModeSignature(modelName, thinkingText, rawSignature);
  const compatible = resolveProviderCompatibleSignature(target, rawSignature, "unknown");

  if (compatible !== "") return compatible;

  return resolveBypassModeSignature(target, rawSignature);
};

/** `hasResolvedThinkingSignature`. */
const hasResolvedThinkingSignature = (modelName: string, signature: string): boolean => {
  const target = signatureProviderFromModelName(modelName);

  if (target === "claude")
    return compatibleAntigravityClaudeThinkingSignature(signature) !== undefined;

  if (compatibleSignatureForProvider(target, signature) !== undefined) return true;

  if (signatureCacheEnabled()) return hasValidSignature(modelName, signature);

  return signature !== "";
};

const TOOL_USE_SIGNATURE_PATHS = [
  "signature",
  "thought_signature",
  "extra_content.google.thought_signature",
] as const;

/** `resolveToolUseThoughtSignature`. */
const resolveToolUseThoughtSignature = (
  modelName: string,
  content: Json,
  allowSyntheticFallback: boolean,
): string => {
  const target = signatureProviderFromModelName(modelName);

  if (target === "gemini") {
    for (const path of TOOL_USE_SIGNATURE_PATHS) {
      const value = get(content, path);

      if (value !== undefined) {
        const signature = resolveProviderCompatibleSignature(
          target,
          asString(value),
          "gemini_function_call",
        );

        if (signature !== "") return signature;
      }
    }

    return allowSyntheticFallback ? GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR : "";
  }

  for (const path of TOOL_USE_SIGNATURE_PATHS) {
    const value = get(content, path);

    if (value !== undefined) {
      const signature = resolveProviderCompatibleSignature(target, asString(value), "unknown");

      if (signature !== "") return signature;
    }
  }

  if (target === "claude") return "";

  return GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR;
};

/**
 * `RequireCachedThinkingSignatures`: the thinking texts of a Claude request whose signatures may be recovered from the
 * signature cache (executors prefetch them from the persistent store before translating).
 */
export const thinkingTextsNeedingCachedSignatures = (
  modelName: string,
  payload: Json,
): string[] => {
  if (!signatureCacheEnabled() || signatureProviderFromModelName(modelName) === "gemini") return [];
  const messages = get(payload, "messages");

  if (!isJsonArray(messages)) return [];
  const texts: string[] = [];

  for (const message of messages) {
    const content = get(message, "content");

    if (!isJsonArray(content)) continue;

    for (const block of content) {
      if (asString(get(block, "type")) !== "thinking") continue;
      const text = getThinkingText(block);

      if (text !== "") texts.push(text);
    }
  }

  return texts;
};

const antigravityClaudeContent = (role: string, parts: Json[]): JsonObject => ({ role, parts });

/** `claudeBase64InlineData`. */
const claudeBase64InlineData = (source: Json | undefined): JsonObject | undefined => {
  if (asString(get(source, "type")) !== "base64") return undefined;
  const mimeType = asString(get(source, "media_type"));
  const data = asString(get(source, "data"));

  if (mimeType === "" || data === "") return undefined;

  return { inlineData: { mimeType, data } };
};

const inlineDataPartOf = (source: Json): JsonObject => {
  const inlineData: JsonObject = {};
  const mimeType = asString(get(source, "media_type"));

  if (mimeType !== "") inlineData["mimeType"] = mimeType;
  const data = asString(get(source, "data"));

  if (data !== "") inlineData["data"] = data;

  return { inlineData };
};

const hasSignatureValue = (part: JsonObject): boolean =>
  asString(part["thoughtSignature"]).trim() !== "";

const systemPartsOf = (root: Json): JsonObject[] => {
  const parts: JsonObject[] = [];
  const system = get(root, "system");

  if (isJsonArray(system)) {
    for (const item of system) {
      if (typeof get(item, "type") === "string" && asString(get(item, "type")) === "text") {
        const text = asString(get(item, "text"));

        if (isClaudeCodeAttributionSystemText(text)) continue;
        parts.push(text !== "" ? { text } : {});
      }
    }
  } else if (typeof system === "string" && !isClaudeCodeAttributionSystemText(system)) {
    parts.push({ text: system });
  }

  return parts;
};

/** Builds the `functionResponse` of a `tool_result` block. */
const buildFunctionResponse = (
  content: Json,
  funcName: string,
  toolCallId: string,
  nameMap: ReadonlyMap<string, string> | undefined,
): JsonObject => {
  const functionResponse: JsonObject = {};
  functionResponse["id"] = toolCallId;
  functionResponse["name"] = mapSanitizedFunctionName(nameMap, funcName);
  const result = get(content, "content");

  if (typeof result === "string") {
    set(functionResponse, "response.result", result);
  } else if (isJsonArray(result)) {
    const nonImage: Json[] = [];
    const images: JsonObject[] = [];

    for (const item of result) {
      if (
        asString(get(item, "type")) === "image" &&
        asString(get(item, "source.type")) === "base64"
      ) {
        // SAFETY: the surrounding check confirmed `source.type` is "base64", so `source` exists.
        images.push(inlineDataPartOf(get(item, "source") as Json));
        continue;
      }

      nonImage.push(item);
    }

    if (nonImage.length === 1)
      setGeminiFunctionResponseRaw(
        functionResponse,
        "response.result",
        JSON.stringify(nonImage[0]),
      );
    else if (nonImage.length > 1)
      setGeminiFunctionResponseRaw(functionResponse, "response.result", JSON.stringify(nonImage));
    else set(functionResponse, "response.result", "");

    // Image data goes inside functionResponse.parts instead of sibling parts to keep base64 out of the text context.
    if (images.length > 0) set(functionResponse, "parts", images);
  } else if (isJsonObject(result)) {
    if (asString(result["type"]) === "image" && asString(get(result, "source.type")) === "base64") {
      // SAFETY: the surrounding check confirmed `source.type` is "base64", so `source` exists.
      set(functionResponse, "parts", [inlineDataPartOf(get(result, "source") as Json)]);
      set(functionResponse, "response.result", "");
    } else {
      setGeminiFunctionResponseResult(functionResponse, "response.result", result);
    }
  } else if (result !== undefined) {
    setGeminiFunctionResponseResult(functionResponse, "response.result", result);
  } else {
    // Content missing entirely.
    set(functionResponse, "response.result", "");
  }

  return functionResponse;
};

/** `ConvertClaudeRequestToAntigravity`. */
export const convertClaudeRequestToAntigravity = (
  modelName: string,
  root: Json,
  _stream: boolean,
): Json => {
  let enableThoughtTranslate = true;

  if (shouldBuildAntigravityWebSearchRequest(modelName, root))
    return buildAntigravityWebSearchRequest(modelName, root);
  const drops = new UserTurnDrops();
  const nameMap = sanitizedFunctionNameMap(root);
  const systemParts = systemPartsOf(root);
  const contentItems: Json[] = [];

  // tool_use_id -> tool name, populated while walking the messages (Gemini requires functionResponse.name).
  const toolNameById = new Map<string, string>();
  let pendingToolUseIds: string[] = [];
  const isGeminiTarget = signatureProviderFromModelName(modelName) === "gemini";

  const messages = get(root, "messages");

  if (isJsonArray(messages)) {
    messages.forEach((message) => {
      const roleResult = get(message, "role");

      if (typeof roleResult !== "string") return;
      const originalRole = roleResult;
      let precedingToolUseIds: string[] = [];

      if (originalRole !== "system" && originalRole !== "developer") {
        precedingToolUseIds = pendingToolUseIds;
        pendingToolUseIds = [];
      }

      let role = originalRole;

      if (role === "assistant") role = "model";
      else if (role === "system" || role === "developer") role = "user";
      const partItems: JsonObject[] = [];

      const appendDetachedCarrier = (signature: string): void => {
        partItems.push({ text: "", thoughtSignature: signature });
      };

      let pendingDetachedSignature = "";
      let pendingDetachedTargetKind = "";

      const clearPending = (): void => {
        pendingDetachedSignature = "";
        pendingDetachedTargetKind = "";
      };

      const setPending = (signature: string, targetKind: string): void => {
        if (pendingDetachedSignature !== "") appendDetachedCarrier(pendingDetachedSignature);
        pendingDetachedSignature = signature;
        pendingDetachedTargetKind = targetKind;
      };

      let contents = get(message, "content");

      if (originalRole === "system" || originalRole === "developer") {
        const reminder = claudeMessageSystemReminderText(contents);

        if (reminder !== undefined) {
          partItems.push({ text: reminder });
          contentItems.push(antigravityClaudeContent(role, partItems));
        }

        return;
      }

      if (isJsonArray(contents)) {
        if (originalRole === "user")
          contents = alignClaudeToolResults(contents, precedingToolUseIds);
        const contentResults = contents;
        const numContents = contentResults.length;

        for (let j = 0; j < numContents; j++) {
          // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
          const contentResult = contentResults[j] as Json;

          const type =
            typeof get(contentResult, "type") === "string"
              ? asString(get(contentResult, "type"))
              : "";

          if (type === "thinking") {
            if (originalRole !== "assistant") continue;
            const thinkingText = getThinkingText(contentResult);
            const signatureResult = get(contentResult, "signature");

            let signature = resolveThinkingSignature(
              modelName,
              thinkingText,
              asString(signatureResult),
            );

            if (signature !== "" && pendingDetachedSignature !== "") {
              if (pendingDetachedSignature !== signature)
                appendDetachedCarrier(pendingDetachedSignature);
              clearPending();
            }

            let signatureFromPendingCarrier = false;

            if (signature === "" && thinkingText !== "" && pendingDetachedSignature !== "") {
              if (
                pendingDetachedTargetKind === "" ||
                pendingDetachedTargetKind === CarrierKind.Any ||
                pendingDetachedTargetKind === CarrierKind.Text
              ) {
                signature = pendingDetachedSignature;
                signatureFromPendingCarrier = true;
              } else {
                appendDetachedCarrier(pendingDetachedSignature);
              }

              clearPending();
            }

            // Unsigned thinking blocks are dropped (never converted to text) for non-Gemini providers.
            const isUnsigned = !hasResolvedThinkingSignature(modelName, signature);

            if (isUnsigned && !isGeminiTarget) {
              enableThoughtTranslate = false;
              continue;
            }

            let nextAcceptsDetachedSignature = false;
            let nextTargetKind: string = CarrierKind.Any;

            if (j + 1 < numContents) {
              switch (asString(get(contentResults[j + 1], "type"))) {
                case "text":
                  nextAcceptsDetachedSignature = true;
                  nextTargetKind = CarrierKind.Text;
                  break;
                case "tool_use":
                  nextAcceptsDetachedSignature = true;
                  nextTargetKind = CarrierKind.Function;
                  break;
              }
            }

            const carrier = decodeGeminiClaudeCarrierSignature(asString(signatureResult));
            const markedCarrier = carrier.marked;
            const validCarrier = carrier.ok;
            const carrierDirection = carrier.direction;
            const carrierTargetKind = carrier.targetKind;

            // Gemini places the signature on the visible text/function part that follows hidden thought text.
            if (thinkingText !== "") {
              const part: JsonObject = { thought: true, text: thinkingText };

              if (signatureFromPendingCarrier) {
                part["thoughtSignature"] = signature;
              } else if (markedCarrier) {
                const carrierTargetsNext =
                  carrierTargetKind === CarrierKind.Any || carrierTargetKind === nextTargetKind;

                if (
                  validCarrier &&
                  carrierDirection === CarrierDirection.Standalone &&
                  (carrierTargetKind === CarrierKind.Text || carrierTargetKind === CarrierKind.Any)
                ) {
                  part["thoughtSignature"] = signature;
                } else if (
                  validCarrier &&
                  carrierDirection === CarrierDirection.Next &&
                  nextAcceptsDetachedSignature &&
                  carrierTargetsNext
                ) {
                  setPending(signature, carrierTargetKind);
                }
              } else if (isGeminiTarget && nextAcceptsDetachedSignature) {
                setPending(signature, nextTargetKind);
              } else if (signature !== "") {
                part["thoughtSignature"] = signature;
              }

              partItems.push(part);
              continue;
            }

            if (!isGeminiTarget) continue;

            if (markedCarrier && !validCarrier) continue;

            if (markedCarrier && carrierDirection === CarrierDirection.Next) {
              if (carrierMatchesAdjacent(contentResults, j, carrierDirection, carrierTargetKind)) {
                setPending(signature, carrierTargetKind);
              }

              continue;
            }

            if (markedCarrier && carrierDirection === CarrierDirection.Standalone) {
              appendDetachedCarrier(signature);
              continue;
            }

            // Tagged trailing carriers bind backward even when another semantic block follows.
            const bindBackward = markedCarrier && carrierDirection === CarrierDirection.Previous;

            if (
              bindBackward &&
              !carrierMatchesAdjacent(contentResults, j, carrierDirection, carrierTargetKind)
            )
              continue;

            if (!bindBackward && nextAcceptsDetachedSignature) {
              setPending(signature, nextTargetKind);
              continue;
            }

            let attached = false;
            let foundSemanticPart = false;

            for (let partIndex = partItems.length - 1; partIndex >= 0; partIndex--) {
              // SAFETY: the index is in bounds (loop bound or length check above); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
              const part = partItems[partIndex] as JsonObject;
              let partTargetKind: string;

              if (part["functionCall"] !== undefined) partTargetKind = CarrierKind.Function;
              else if (part["text"] !== undefined && asString(part["text"]) !== "")
                partTargetKind = CarrierKind.Text;
              else continue;
              foundSemanticPart = true;

              if (
                markedCarrier &&
                carrierTargetKind !== CarrierKind.Any &&
                carrierTargetKind !== partTargetKind
              )
                break;
              const partSignature = asString(part["thoughtSignature"]).trim();

              const replaceFallback =
                bindBackward &&
                partTargetKind === CarrierKind.Function &&
                partSignature === GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR;

              if (partSignature === "" || replaceFallback) {
                part["thoughtSignature"] = signature;
                attached = true;
              }

              break;
            }

            if (!attached && (foundSemanticPart || bindBackward)) appendDetachedCarrier(signature);
            else if (!attached) setPending(signature, carrierTargetKind);
          } else if (type === "text") {
            const prompt = asString(get(contentResult, "text"));

            // Skip empty text parts: Gemini rejects "required oneof field 'data' must have one initialized field".
            if (prompt === "") continue;
            const part: JsonObject = { text: prompt };

            if (pendingDetachedSignature !== "") {
              if (
                pendingDetachedTargetKind === "" ||
                pendingDetachedTargetKind === CarrierKind.Any ||
                pendingDetachedTargetKind === CarrierKind.Text
              ) {
                part["thoughtSignature"] = pendingDetachedSignature;
              } else {
                appendDetachedCarrier(pendingDetachedSignature);
              }

              clearPending();
            }

            partItems.push(part);
          } else if (type === "tool_use") {
            // No dummy thinking blocks: Antigravity validates signatures and rejects dummy values.
            const originalFunctionName = asString(get(contentResult, "name"));
            const functionName = mapSanitizedFunctionName(nameMap, originalFunctionName);
            const args = get(contentResult, "input");
            const functionId = asString(get(contentResult, "id"));

            if (functionId !== "" && originalFunctionName !== "")
              toolNameById.set(functionId, originalFunctionName);

            let argsValue: Json | undefined;

            if (isJsonObject(args)) argsValue = args;
            else if (args !== undefined) {
              if (typeof args === "string") {
                const parsed = tryParseJson(args);
                argsValue = isJsonObject(parsed) ? parsed : args;
              } else if (args === null) argsValue = {};
              else argsValue = args;
            }

            if (argsValue !== undefined) {
              const part: JsonObject = {};
              let signature = resolveToolUseThoughtSignature(modelName, contentResult, true);

              if (pendingDetachedSignature !== "") {
                const pendingMatchesTool =
                  pendingDetachedTargetKind === "" ||
                  pendingDetachedTargetKind === CarrierKind.Any ||
                  pendingDetachedTargetKind === CarrierKind.Function;

                if (
                  pendingMatchesTool &&
                  (signature === "" || signature === GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR)
                ) {
                  signature = pendingDetachedSignature;
                } else {
                  appendDetachedCarrier(pendingDetachedSignature);
                }

                clearPending();
              }

              if (signature !== "") part["thoughtSignature"] = signature;
              const functionCall: JsonObject = {};

              if (functionId !== "") functionCall["id"] = functionId;
              functionCall["name"] = functionName;
              functionCall["args"] = argsValue;
              part["functionCall"] = functionCall;
              partItems.push(part);

              if (originalRole === "assistant") pendingToolUseIds.push(functionId);
            }
          } else if (type === "tool_result") {
            const toolCallId = asString(get(contentResult, "tool_use_id"));

            if (toolCallId !== "") {
              let funcName = toolNameById.get(toolCallId);

              if (funcName === undefined) {
                // Derive a semantic name from the id by stripping the last two dash-separated segments.
                const segments = toolCallId.split("-");
                funcName = segments.length > 2 ? segments.slice(0, -2).join("-") : "";

                if (funcName === "") funcName = toolCallId;
              }

              partItems.push({
                functionResponse: buildFunctionResponse(
                  contentResult,
                  funcName,
                  toolCallId,
                  nameMap,
                ),
              });
            }
          } else if (type === "image") {
            const source = get(contentResult, "source");

            if (asString(get(source, "type")) === "base64") {
              // SAFETY: the surrounding check confirmed `source.type` is "base64", so `source` exists.
              partItems.push(inlineDataPartOf(source as Json));
            } else if (originalRole === "user") {
              // A part that cannot be inlined (url or file source) is dropped; the turn is refused only if nothing is left.
              drops.drop("image");
            }
          } else if (type === "document" || type === "container_upload") {
            const part = claudeBase64InlineData(get(contentResult, "source"));

            if (part !== undefined) partItems.push(part);
            else if (originalRole === "user") drops.drop(type);
          }
        }

        if (pendingDetachedSignature !== "") {
          appendDetachedCarrier(pendingDetachedSignature);
          clearPending();
        }

        // Whitespace-only text is forwarded but never keeps an emptied turn alive.
        if (originalRole === "user") drops.endTurn(countSendableGeminiParts(partItems));

        if (partItems.length === 0) return;
        let clientContent = antigravityClaudeContent(role, partItems);

        if (role === "model" && partItems.length > 1) {
          // Reorder model parts: thinking first, regular content second, function calls and trailing carriers last.
          const thinkingParts: JsonObject[] = [];
          const regularParts: JsonObject[] = [];
          const trailingParts: JsonObject[] = [];
          let needsReorder = false;
          let previousCategory = -1;
          let seenFunctionCall = false;

          for (const part of partItems) {
            let category = 1;
            const isSignatureCarrier = part["text"] === "" && hasSignatureValue(part);
            const isFunctionTailCarrier = isSignatureCarrier && seenFunctionCall;

            if (part["thought"] === true) {
              category = 0;
              thinkingParts.push(part);
            } else if (part["functionCall"] !== undefined || isFunctionTailCarrier) {
              category = 2;
              trailingParts.push(part);
              seenFunctionCall = seenFunctionCall || part["functionCall"] !== undefined;
            } else {
              regularParts.push(part);
            }

            needsReorder = needsReorder || category < previousCategory;
            previousCategory = category;
          }

          if (needsReorder)
            clientContent = antigravityClaudeContent(role, [
              ...thinkingParts,
              ...regularParts,
              ...trailingParts,
            ]);
        }

        contentItems.push(clientContent);
      } else if (typeof contents === "string") {
        const prompt = contents;
        contentItems.push(antigravityClaudeContent(role, [prompt !== "" ? { text: prompt } : {}]));
      }
    });
  }

  // tools
  let toolsJson: Json[] | undefined;
  let toolDeclCount = 0;

  const allowedToolKeys = new Set([
    "name",
    "description",
    "behavior",
    "parameters",
    "parametersJsonSchema",
    "response",
    "responseJsonSchema",
  ]);

  const tools = get(root, "tools");

  if (isJsonArray(tools)) {
    const functionDeclarations: Json[] = [];

    for (const toolResult of tools) {
      if (isClaudeTypedWebSearchToolType(asString(get(toolResult, "type")))) continue;
      const inputSchema = get(toolResult, "input_schema");

      if (isJsonObject(inputSchema) && isJsonObject(toolResult)) {
        const cleaned = cleanJsonSchemaForAntigravity(structuredClone(inputSchema));
        const tool: JsonObject = structuredClone(toolResult);
        delete tool["input_schema"];
        tool["parametersJsonSchema"] = cleaned;
        const original = asString(tool["name"]);
        const mapped = mapSanitizedFunctionName(nameMap, original);

        if (typeof tool["name"] !== "string" || mapped !== original) tool["name"] = mapped;

        for (const key of Object.keys(tool)) if (!allowedToolKeys.has(key)) delete tool[key];
        functionDeclarations.push(tool);
      }
    }

    if (functionDeclarations.length > 0) {
      const deduplicated = deduplicateFunctionDeclarations(functionDeclarations);
      toolDeclCount = deduplicated.length;

      if (toolDeclCount > 0) toolsJson = [{ functionDeclarations: deduplicated }];
    }
  }

  const out: Json = { model: modelName, request: { contents: [] } };

  // tool_choice metadata
  const toolChoiceResult = get(root, "tool_choice");
  let toolChoiceType = "";
  let toolChoiceName = "";

  if (toolChoiceResult !== undefined) {
    if (isJsonObject(toolChoiceResult)) {
      toolChoiceType = asString(toolChoiceResult["type"]);
      toolChoiceName = asString(toolChoiceResult["name"]);
    } else if (typeof toolChoiceResult === "string") toolChoiceType = toolChoiceResult;
  }

  const isToolChoiceNone = toolChoiceType.trim().toLowerCase() === "none";

  // Interleaved thinking hint when both tools and thinking are active.
  const hasTools = toolDeclCount > 0 && !isToolChoiceNone;
  const thinkingResult = get(root, "thinking");
  const thinkingType = asString(get(thinkingResult, "type"));

  const hasThinking =
    isJsonObject(thinkingResult) &&
    (thinkingType === "enabled" || thinkingType === "adaptive" || thinkingType === "auto");

  const lowerModel = modelName.toLowerCase();
  const isClaudeThinking = lowerModel.includes("claude") && lowerModel.includes("thinking");

  if (hasTools && hasThinking && isClaudeThinking) {
    systemParts.push({
      text: "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.",
    });
  }

  if (systemParts.length > 0)
    set(out, "request.systemInstruction", antigravityClaudeContent("user", systemParts));

  if (contentItems.length > 0) {
    if (lowerModel.includes("claude")) {
      set(
        out,
        "request.contents",
        mergeAdjacentGeminiUserContents(splitGeminiFunctionResponseTurns(contentItems)),
      );
    } else {
      set(out, "request.contents", mergeAdjacentGeminiContents(contentItems));
    }
  }

  if (toolDeclCount > 0 && !isToolChoiceNone && toolsJson !== undefined)
    set(out, "request.tools", toolsJson);

  if (toolChoiceResult !== undefined) {
    switch (toolChoiceType.trim().toLowerCase()) {
      case "auto":
        set(out, "request.toolConfig.functionCallingConfig.mode", "AUTO");
        break;
      case "none":
        set(out, "request.toolConfig.functionCallingConfig.mode", "NONE");
        del(out, "request.tools");
        break;
      case "any":
        set(out, "request.toolConfig.functionCallingConfig.mode", "ANY");
        break;
      case "tool":
        set(out, "request.toolConfig.functionCallingConfig.mode", "ANY");

        if (toolChoiceName !== "") {
          set(out, "request.toolConfig.functionCallingConfig.allowedFunctionNames", [
            mapSanitizedFunctionName(nameMap, toolChoiceName),
          ]);
        }

        break;
    }
  }

  // Anthropic thinking -> Gemini thinkingBudget/thinkingLevel.
  if (enableThoughtTranslate && isJsonObject(thinkingResult)) {
    switch (thinkingType) {
      case "enabled": {
        const budget = thinkingResult["budget_tokens"];

        if (typeof budget === "number") {
          set(out, "request.generationConfig.thinkingConfig.thinkingBudget", asInt(budget));
        }

        break;
      }

      case "adaptive":
      case "auto": {
        // Explicit output_config.effort passes through as thinkingLevel, otherwise "enabled with model maximum".
        let effort = "";
        const value = get(root, "output_config.effort");

        if (typeof value === "string") effort = value.trim().toLowerCase();
        set(
          out,
          "request.generationConfig.thinkingConfig.thinkingLevel",
          effort !== "" ? effort : "high",
        );
        break;
      }
    }
  }

  const numeric = (key: string): number | undefined => {
    const value = get(root, key);

    return typeof value === "number" ? asFloat(value) : undefined;
  };

  const temperature = numeric("temperature");

  if (temperature !== undefined) set(out, "request.generationConfig.temperature", temperature);
  const topP = numeric("top_p");

  if (topP !== undefined) set(out, "request.generationConfig.topP", topP);
  const topK = numeric("top_k");

  if (topK !== undefined) set(out, "request.generationConfig.topK", topK);
  const maxTokens = numeric("max_tokens");

  if (maxTokens !== undefined) set(out, "request.generationConfig.maxOutputTokens", maxTokens);

  attachDefaultSafetySettings(out, "request.safetySettings");

  if (isGeminiTarget) sanitizeGeminiRequestThoughtSignatures(out, "request.contents");

  const refusal = drops.err(out);

  if (refusal !== undefined) throw refusal;

  return out;
};
