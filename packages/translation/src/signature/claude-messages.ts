/**
 * Provider-aware signature sanitising of Claude `/v1/messages` history.
 *
 * Go source: internal/signature/claude_messages_sanitize.go (`SanitizeClaudeMessagesSignaturesForTarget`,
 * `SanitizeClaudeMessagesSignaturesForModel`, `SanitizeClaudeMessagesForClaudeUpstream`). Bodies are parsed JSON
 * mutated in place (Go returns a rewritten payload); the report carries the per-block decisions.
 */
import {
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
import { isEmptyClaudeThinkingPlaceholder } from "./claude.ts";
import {
  decideSignatureCompatibility,
  type SignatureBlockKind,
  type SignatureCompatibilityDecision,
  type SignatureProvider,
  signatureProviderFromModelName,
} from "./provider.ts";

/**
 * `CodexCommentarySignatureMarker`: the Commissary-internal marker carried in the `signature` of the Claude thinking
 * block that relays a Codex commentary message. It is not a provider signature and must never reach an upstream.
 */
export const CODEX_COMMENTARY_SIGNATURE_MARKER = "cpa:commentary:v1";

/** `IsCodexCommentarySignatureMarker`: exactly the marker, ignoring surrounding whitespace. */
export const isCodexCommentarySignatureMarker = (rawSignature: string): boolean =>
  rawSignature.trim() === CODEX_COMMENTARY_SIGNATURE_MARKER;

export interface CommentaryRestore {
  readonly payload: Json;
  readonly restored: number;
}

/**
 * `RestoreCodexCommentaryMarkers`: rewrites every marked thinking block as a plain text block, independent of provider
 * signature policy. Blocks with empty thinking text are dropped, and a message left with no content is removed. Unlike
 * Go it never mutates `payload`: the input is returned as is when nothing is marked, else a copy with new `messages`.
 */
export const restoreCodexCommentaryMarkers = (payload: Json): CommentaryRestore => {
  const messages = get(payload, "messages");

  if (!isJsonArray(messages) || !isJsonObject(payload)) return { payload, restored: 0 };
  let restored = 0;
  const kept: Json[] = [];

  for (const message of messages) {
    const content = get(message, "content");

    if (!isJsonObject(message) || !isJsonArray(content)) {
      kept.push(message);
      continue;
    }

    let modified = false;
    const parts: Json[] = [];

    for (const part of content) {
      if (
        asString(get(part, "type")) !== "thinking" ||
        !isCodexCommentarySignatureMarker(asString(get(part, "signature")))
      ) {
        parts.push(part);
        continue;
      }

      restored++;
      modified = true;
      const text = asString(get(part, "thinking"));

      if (text !== "") parts.push({ type: "text", text });
    }

    if (!modified) kept.push(message);
    else if (parts.length > 0) kept.push({ ...message, content: parts });
  }

  return restored === 0
    ? { payload, restored }
    : { payload: { ...payload, messages: kept }, restored };
};

export interface ClaudeMessagesSignatureSanitizeOptions {
  readonly targetProvider: SignatureProvider;
  readonly targetModel?: string;
  readonly dropEmptyMessages?: boolean;
  readonly dropToolSignatures?: boolean;
  readonly dropEmptyThinkingPlaceholders?: boolean;
  /** Keep compatibility-mode thinking blocks with their original (possibly opaque) signatures. */
  readonly preserveEmptyThinkingBlocks?: boolean;
}

export interface SignatureSanitizeReport {
  readonly targetProvider: SignatureProvider;
  preserved: number;
  droppedBlocks: number;
  droppedSignatures: number;
  replacedSignatures: number;
  readonly decisions: SignatureCompatibilityDecision[];
}

const TOOL_USE_SIGNATURE_PATHS = [
  "signature",
  "thoughtSignature",
  "thought_signature",
  "extra_content.google.thought_signature",
] as const;

/** `deleteEmptyJSONObjectPath`. */
const deleteEmptyObjectPath = (part: JsonObject, path: string): boolean => {
  const value = get(part, path);

  if (!isJsonObject(value) || Object.keys(value).length !== 0) return false;
  del(part, path);

  return true;
};

const cleanExtraContent = (part: JsonObject): boolean => {
  const google = deleteEmptyObjectPath(part, "extra_content.google");
  const extra = deleteEmptyObjectPath(part, "extra_content");

  return google || extra;
};

/** `stripClaudeToolUseSignatureFields`: every signature field and the `model` provenance of a tool_use block. */
const stripToolUseSignatureFields = (part: JsonObject): boolean => {
  let changed = false;

  for (const path of [...TOOL_USE_SIGNATURE_PATHS, "model"]) {
    if (!exists(part, path)) continue;
    del(part, path);
    changed = true;
  }

  return cleanExtraContent(part) || changed;
};

interface ToolUseSanitization {
  readonly changed: boolean;
  readonly decisions: SignatureCompatibilityDecision[];
}

const toolUseBlockKind = (target: SignatureProvider): SignatureBlockKind => {
  switch (target) {
    case "claude":
      return "claude_thinking";
    case "gpt":
      return "gpt_reasoning";
    default:
      return "gemini_function_call";
  }
};

/** `sanitizeClaudeToolUseSignature`. */
const sanitizeToolUseSignature = (
  part: JsonObject,
  target: SignatureProvider,
  targetModel: string,
  messageIndex: number,
  partIndex: number,
): ToolUseSanitization => {
  let changed = false;
  const decisions: SignatureCompatibilityDecision[] = [];

  for (const path of TOOL_USE_SIGNATURE_PATHS) {
    const current = get(part, path);

    if (current === undefined) continue;

    const blockKind = toolUseBlockKind(target);

    const raw = asString(current);
    const decision = decideSignatureCompatibility(target, raw, blockKind, targetModel);
    decisions.push({
      ...decision,
      reason: `messages[${messageIndex}].content[${partIndex}].${path}: ${decision.reason}`,
    });

    switch (decision.action) {
      case "preserve":
        if (decision.normalizedSignature !== "" && decision.normalizedSignature !== raw) {
          set(part, path, decision.normalizedSignature);
          changed = true;
        }

        break;
      case "replace_with_gemini_bypass":
        set(part, path, decision.replacementSignature);
        changed = true;
        break;
      default:
        del(part, path);
        changed = true;
    }
  }

  const result: ToolUseSanitization = { changed: cleanExtraContent(part) || changed, decisions };

  return result;
};

/**
 * `SanitizeClaudeMessagesSignaturesForTarget`: compatible thinking signatures are kept (normalised for the target),
 * incompatible thinking blocks are removed so a conversation can continue across Claude, GPT/Codex, Gemini and Kimi
 * models. Mutates `payload.messages` in place.
 */
export const sanitizeClaudeMessagesSignaturesForTarget = (
  payload: Json,
  options: ClaudeMessagesSignatureSanitizeOptions,
): SignatureSanitizeReport => {
  let target: SignatureProvider =
    options.targetProvider === "gemini_bypass" ? "gemini" : options.targetProvider;

  const targetModel = options.targetModel ?? "";

  if (target === "unknown" && targetModel !== "")
    target = signatureProviderFromModelName(targetModel);

  const report: SignatureSanitizeReport = {
    targetProvider: target,
    preserved: 0,
    droppedBlocks: 0,
    droppedSignatures: 0,
    replacedSignatures: 0,
    decisions: [],
  };

  const messages = get(payload, "messages");

  if (!isJsonArray(messages) || !isJsonObject(payload)) return report;

  const keptMessages: Json[] = [];
  let modified = false;

  for (const [i, message] of messages.entries()) {
    const content = get(message, "content");

    if (!isJsonObject(message) || !isJsonArray(content)) {
      keptMessages.push(message);
      continue;
    }

    const keptParts: Json[] = [];
    let messageModified = false;

    for (const [j, part] of content.entries()) {
      const partType = asString(get(part, "type"));

      if (partType === "tool_use" && isJsonObject(part)) {
        if (options.dropToolSignatures === true) {
          if (stripToolUseSignatureFields(part)) {
            messageModified = true;
            report.droppedSignatures++;
          }
        } else {
          const result = sanitizeToolUseSignature(part, target, targetModel, i, j);
          report.decisions.push(...result.decisions);

          if (result.changed) messageModified = true;

          for (const decision of result.decisions) {
            if (decision.action === "preserve") report.preserved++;
            else if (decision.action === "replace_with_gemini_bypass") report.replacedSignatures++;
            else report.droppedSignatures++;
          }
        }

        keptParts.push(part);
        continue;
      }

      if (partType !== "thinking" || !isJsonObject(part)) {
        keptParts.push(part);
        continue;
      }

      const markedSignature = asString(get(part, "signature"));

      if (isCodexCommentarySignatureMarker(markedSignature)) {
        // Not a provider signature: restore its text as a plain assistant text block.
        const text = asString(get(part, "thinking"));

        if (text !== "") {
          keptParts.push({ type: "text", text });
          report.droppedSignatures++;
        } else {
          report.droppedBlocks++;
        }

        messageModified = true;
        continue;
      }

      if (options.preserveEmptyThinkingBlocks === true) {
        report.preserved++;
        keptParts.push(part);
        continue;
      }

      if (
        target === "claude" &&
        isEmptyClaudeThinkingPlaceholder(part) &&
        options.dropEmptyThinkingPlaceholders !== true
      ) {
        keptParts.push(part);
        continue;
      }

      const raw = asString(get(part, "signature"));
      const decision = decideSignatureCompatibility(target, raw, "claude_thinking", targetModel);
      report.decisions.push({
        ...decision,
        reason: `messages[${i}].content[${j}]: ${decision.reason}`,
      });

      switch (decision.action) {
        case "preserve":
          report.preserved++;

          if (decision.normalizedSignature !== "" && decision.normalizedSignature !== raw) {
            part["signature"] = decision.normalizedSignature;
            messageModified = true;
          }

          keptParts.push(part);
          break;
        case "replace_with_gemini_bypass":
          report.replacedSignatures++;
          part["signature"] = decision.replacementSignature;
          messageModified = true;
          keptParts.push(part);
          break;
        case "drop_signature":
          report.droppedSignatures++;
          delete part["signature"];
          messageModified = true;
          keptParts.push(part);
          break;
        default:
          report.droppedBlocks++;
          messageModified = true;
      }
    }

    if (!messageModified) {
      keptMessages.push(message);
      continue;
    }

    modified = true;

    if (keptParts.length === 0 && options.dropEmptyMessages === true) continue;
    message["content"] = keptParts;
    keptMessages.push(message);
  }

  if (modified) payload["messages"] = keptMessages;

  return report;
};

/** `SanitizeClaudeMessagesSignaturesForModel`: the provider family implied by `targetModel`. */
export const sanitizeClaudeMessagesSignaturesForModel = (
  payload: Json,
  targetModel: string,
): SignatureSanitizeReport =>
  sanitizeClaudeMessagesSignaturesForTarget(payload, {
    targetProvider: signatureProviderFromModelName(targetModel),
    targetModel,
    dropEmptyMessages: true,
  });

/**
 * `SanitizeClaudeMessagesForClaudeUpstream`: valid Claude signatures are normalised to the provider-native E form (CAIS
 * kept), incompatible thinking blocks dropped, tool_use blocks keep only their tool-call payload.
 */
export const sanitizeClaudeMessagesForClaudeUpstream = (
  payload: Json,
  targetModel: string,
  preserveEmptyThinkingBlocks = false,
): SignatureSanitizeReport =>
  sanitizeClaudeMessagesSignaturesForTarget(payload, {
    targetProvider: "claude",
    targetModel,
    dropEmptyMessages: true,
    dropToolSignatures: true,
    dropEmptyThinkingPlaceholders: !preserveEmptyThinkingBlocks,
    preserveEmptyThinkingBlocks,
  });
