/**
 * Devin Connect-RPC wire messages: `GetChatMessageRequest` encoding, response frame decoding, the Connect envelope
 * and the EOS trailer error mapping.
 *
 * Go source: internal/runtime/executor/helps/devin_wire.go (BuildDevinClientMetadataBytes,
 * GenerateDevinDeviceFingerprint, BuildDevinGetChatMessageRequest, ParseDevinFrame, parseDevinToolCallDelta,
 * parseDevinUsageField, ParseDevinResponseDimensionGroups, ParseDevinTrailerError, SanitizeDevinSystemPrompt,
 * WrapConnectEnvelope). Field numbers follow docs/research/providers-other.md §4.4.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { sha256Hex } from "@commissary/core";
import { isJsonObject, tryParseJson } from "@commissary/json";
import { isClaudeCodeAttributionSystemText } from "@commissary/translation";
import type { SensitiveWordMatcher } from "../claude/cloaking.ts";
import {
  fieldDouble,
  fieldFloat,
  fieldText,
  ProtoError,
  ProtoWriter,
  readFields,
  WireType,
} from "./protobuf.ts";
import { devinWireToolDescription, isCodexAppAutomationUpdate } from "./tools.ts";

export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";

export const DEVIN_CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";

export const DEVIN_CLIENT_NAME = "chisel";

export const DEVIN_CLIENT_VERSION = "3000.10.21";

export const DEVIN_FINGERPRINT_HEX_LENGTH = 732;

export const DEVIN_DEFAULT_MAX_TOKENS = 128000;

export const CONNECT_FLAG_COMPRESSED = 0x01;

export const CONNECT_FLAG_END_STREAM = 0x02;

export interface DevinTool {
  readonly name: string;
  readonly description: string;
  /** Raw JSON schema text (`""` = none). */
  readonly parameters: string;
}

export interface DevinToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface DevinImage {
  readonly base64Data: string;
  readonly mimeType: string;
}

/** One turn of the request history (repeated field 3). */
export interface DevinPrompt {
  messageId: string;
  /** 1 = user, 2 = assistant, 4 = tool. */
  source: number;
  content: string;
  images: DevinImage[];
  toolCalls: DevinToolCall[];
  toolCallId: string;
  /** Retained when a tool result was downgraded from source 4 to 1. */
  originalToolCallId: string;
  isOrphanedTool: boolean;
  /** Type of a user media part Devin cannot send; never put on the wire. */
  droppedPart: string;
  thinking: string;
  signature: Uint8Array;
  signatureType: string;
}

export const newDevinPrompt = (
  init: Partial<DevinPrompt> & { readonly source: number },
): DevinPrompt => ({
  messageId: randomUUID(),
  content: "",
  images: [],
  toolCalls: [],
  toolCallId: "",
  originalToolCallId: "",
  isOrphanedTool: false,
  droppedPart: "",
  thinking: "",
  signature: new Uint8Array(0),
  signatureType: "",
  ...init,
});

// ---------------------------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------------------------

/** `GenerateDevinDeviceFingerprint`: 732 hex characters, random without a seed, else derived from the seed. */
export const generateDeviceFingerprint = (seed: string): string => {
  if (seed === "") return randomBytes(DEVIN_FINGERPRINT_HEX_LENGTH / 2).toString("hex");
  let out = "";

  for (let counter = 0; out.length < DEVIN_FINGERPRINT_HEX_LENGTH; counter++)
    out += sha256Hex(`${seed}-${counter}`);

  return out.slice(0, DEVIN_FINGERPRINT_HEX_LENGTH);
};

/** `BuildDevinClientMetadataBytes` (field 1 of every request). */
export const buildClientMetadata = (
  sessionToken: string,
  deviceSeed: string,
  osName = "linux",
): Uint8Array =>
  new ProtoWriter()
    .string(1, DEVIN_CLIENT_NAME)
    .string(2, DEVIN_CLIENT_VERSION)
    .string(3, sessionToken)
    .string(4, "en")
    .string(5, osName)
    .string(7, DEVIN_CLIENT_VERSION)
    .string(12, DEVIN_CLIENT_NAME)
    .string(31, generateDeviceFingerprint(deviceSeed))
    .toBytes();

/** `GenerateDevinSentryTrace`: `<32 hex>-<16 hex>-1`. */
export const generateSentryTrace = (): string =>
  `${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-1`;

/** `WrapConnectEnvelope`: `[flag][u32 BE length][payload]`. */
export const wrapConnectEnvelope = (payload: Uint8Array, flag = 0): Uint8Array => {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flag;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);

  return out;
};

const SYSTEM_PROMPT_DROPS = [
  "authorized security testing",
  "destructive techniques, DoS attacks",
  "Claude Code is available as a CLI",
  "Fast mode for Claude Code",
  "Codex refers to the open-source agentic coding interface",
  "- Don’t output ANSI escape codes directly — the CLI renderer applies them.",
];

/** `SanitizeDevinSystemPrompt`: drops Claude Code attribution lines, then obfuscates sensitive words. */
export const sanitizeDevinSystemPrompt = (
  prompt: string,
  matcher: SensitiveWordMatcher | undefined,
): string => {
  if (prompt === "") return "";
  const kept: string[] = [];

  for (const line of prompt.replaceAll("\r\n", "\n").split("\n")) {
    const trimmed = line.trim();

    if (isClaudeCodeAttributionSystemText(trimmed)) continue;

    if (trimmed.startsWith("You are Claude Code")) continue;

    if (SYSTEM_PROMPT_DROPS.some((phrase) => trimmed.includes(phrase))) continue;

    if (matcher?.matches(trimmed) === true) continue;
    kept.push(line);
  }

  const result = kept.join("\n").trim();

  return matcher !== undefined && result !== "" ? matcher.obfuscate(result) : result;
};

export interface DevinChatRequest {
  readonly sessionToken: string;
  readonly deviceSeed: string;
  readonly chatModelUid: string;
  readonly systemPrompt: string;
  readonly prompts: ReadonlyArray<DevinPrompt>;
  readonly tools: ReadonlyArray<DevinTool>;
  readonly temperature: number | undefined;
  readonly maxTokens: number;
  readonly sessionId: string;
  readonly cascadeId: string;
  /** Next 0-based request ordinal of the session (field 15.2, omitted when 0). */
  readonly turnIndex: number;
  readonly matcher: SensitiveWordMatcher | undefined;
  readonly osName?: string;
}

/** `BuildDevinGetChatMessageRequest`. */
export const buildGetChatMessageRequest = (input: DevinChatRequest): Uint8Array => {
  const maxTokens = input.maxTokens > 0 ? input.maxTokens : DEVIN_DEFAULT_MAX_TOKENS;
  const sessionId = input.sessionId !== "" ? input.sessionId : randomUUID();
  const cascadeId = input.cascadeId !== "" ? input.cascadeId : sessionId;
  const request = new ProtoWriter();
  request.bytes(1, buildClientMetadata(input.sessionToken, input.deviceSeed, input.osName));

  if (input.systemPrompt !== "") {
    const sanitized = sanitizeDevinSystemPrompt(input.systemPrompt, input.matcher);

    if (sanitized !== "") request.string(2, sanitized);
  }

  for (const prompt of input.prompts) {
    const message = new ProtoWriter();
    message.string(1, prompt.messageId !== "" ? prompt.messageId : randomUUID());
    message.varint(2, prompt.source > 0 ? prompt.source : 1);
    message.string(3, prompt.content);

    for (const call of prompt.toolCalls) {
      const encoded = new ProtoWriter();

      if (call.id !== "") encoded.string(1, call.id);

      if (call.name !== "") encoded.string(2, call.name);

      if (call.arguments !== "") encoded.string(3, call.arguments);
      message.bytes(6, encoded.toBytes());
    }

    if (prompt.toolCallId !== "") message.string(7, prompt.toolCallId);

    for (const image of prompt.images) {
      const data = image.base64Data.trim();

      if (data === "") continue;
      const mime = image.mimeType.trim();
      message.bytes(
        10,
        new ProtoWriter()
          .string(1, data)
          .string(2, mime !== "" ? mime : "image/png")
          .toBytes(),
      );
    }

    if (prompt.thinking !== "") message.string(11, prompt.thinking);

    if (prompt.signature.length > 0) message.bytes(12, prompt.signature);

    if (prompt.signatureType !== "") message.string(18, prompt.signatureType);
    request.bytes(3, message.toBytes());
  }

  request.varint(7, 5);
  request.bytes(
    8,
    new ProtoWriter()
      .varint(1, 1)
      .varint(2, maxTokens)
      .varint(3, 400)
      .double(5, input.temperature ?? 1.0)
      .varint(7, 40)
      .double(8, Math.fround(0.95))
      .toBytes(),
  );

  for (const tool of input.tools) {
    if (tool.name === "" || isCodexAppAutomationUpdate("", tool.name)) continue;
    const encoded = new ProtoWriter().string(1, tool.name);
    const description = devinWireToolDescription(tool.name, tool.description);

    if (description !== "") encoded.string(2, description);

    if (tool.parameters !== "") encoded.bytes(3, new TextEncoder().encode(tool.parameters));
    request.bytes(10, encoded.toBytes());
  }

  const thread = new ProtoWriter().string(1, sessionId);

  if (input.turnIndex > 0) thread.varint(2, input.turnIndex);
  thread.varint(3, 4);
  const last = input.prompts[input.prompts.length - 1];

  if (last !== undefined && last.source === 1) {
    const previous = input.prompts[input.prompts.length - 2];

    if (input.turnIndex === 0 || previous === undefined || previous.source !== 1)
      thread.varint(4, 14);
  }

  request.bytes(15, thread.toBytes());
  request.string(16, cascadeId);
  request.varint(20, 1);
  request.string(21, input.chatModelUid);

  return request.toBytes();
};

// ---------------------------------------------------------------------------------------------------------------
// Response frames
// ---------------------------------------------------------------------------------------------------------------

export interface DevinUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  statusCode: number;
  requestId: string;
  modelName: string;
  headers: Record<string, string>;
}

/** `devinTotalInputTokens`: the prompt is reported in three disjoint parts (uncached, cache write, cache read). */
export const devinTotalInputTokens = (usage: DevinUsage): number =>
  usage.promptTokens + usage.cachedTokens + usage.cacheWriteTokens;

export interface DevinToolCallDelta {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly invalidJsonStr: string;
  readonly invalidJsonErr: string;
  readonly isCustomToolCall: boolean;
}

export interface DevinFrame {
  outputId: string;
  timestamp: number;
  /** Raw UTF-8 bytes of the text delta (frames may split multi-byte characters). */
  content: Uint8Array;
  thinking: Uint8Array;
  deltaTokens: number;
  stopReason: number;
  toolCalls: DevinToolCallDelta[];
  deltaSignature: Uint8Array;
  deltaSignatureType: string;
  latency: number;
  messageId: string;
  usage: DevinUsage | undefined;
  dimensionGroups: Uint8Array[];
  unknownFields: number[];
}

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const [only] = parts;

  if (parts.length === 1 && only !== undefined) return only;
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

const parseToolCallDelta = (data: Uint8Array): DevinToolCallDelta => {
  let id = "";
  let name = "";
  let args = "";
  let invalidJsonStr = "";
  let invalidJsonErr = "";
  let isCustomToolCall = false;

  for (const field of readFields(data)) {
    if (field.wire === WireType.Varint) {
      if (field.num === 6) isCustomToolCall = field.varint !== 0;
    } else if (field.wire === WireType.Bytes) {
      switch (field.num) {
        case 1:
          id = fieldText(field);
          break;
        case 2:
          name = fieldText(field);
          break;
        case 3:
          args = fieldText(field);
          break;
        case 4:
          invalidJsonStr = fieldText(field);
          break;
        case 5:
          invalidJsonErr = fieldText(field);
      }
    }
  }

  return { id, name, arguments: args, invalidJsonStr, invalidJsonErr, isCustomToolCall };
};

/** `parseDevinTimestamp`: field 1 (seconds) of the timestamp message. */
const parseTimestamp = (data: Uint8Array): number => {
  let seconds = 0;

  try {
    for (const field of readFields(data))
      if (field.wire === WireType.Varint && field.num === 1) seconds = field.varint;
  } catch {
    // Go stops at the first malformed byte and keeps what it read.
  }

  return seconds;
};

const isPrintableAscii = (data: Uint8Array): boolean =>
  data.every((byte) => byte >= 32 && byte <= 126);

const parseHeaderField = (data: Uint8Array): readonly [string, string] => {
  let key = "";
  let value = "";

  try {
    for (const field of readFields(data)) {
      if (field.wire !== WireType.Bytes) continue;

      if (field.num === 1) key = fieldText(field);
      else if (field.num === 2) value = fieldText(field);
    }
  } catch {
    // Keep the partial pair like Go.
  }

  return [key, value];
};

export const emptyDevinUsage = (): DevinUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  statusCode: 0,
  requestId: "",
  modelName: "",
  headers: {},
});

/** `parseDevinUsageField` (frame field 7). */
const parseUsage = (data: Uint8Array): DevinUsage => {
  const usage = emptyDevinUsage();

  try {
    for (const field of readFields(data)) {
      if (field.wire === WireType.Varint) {
        switch (field.num) {
          case 2:
            usage.promptTokens += field.varint;
            break;
          case 3:
            usage.completionTokens = field.varint;
            break;
          case 4:
            usage.cacheWriteTokens += field.varint;
            break;
          case 5:
            usage.cachedTokens = field.varint;
            break;
          case 6:
            usage.statusCode = field.varint;
        }
      } else if (field.wire === WireType.Bytes) {
        if (field.num === 8) {
          const [key, value] = parseHeaderField(field.bytes);

          if (key !== "") {
            usage.headers[key] = value;
            const lower = key.toLowerCase();

            if ((lower === "x-request-id" || lower === "request-id") && value !== "")
              usage.requestId = value;
          } else if (
            field.bytes.length > 0 &&
            isPrintableAscii(field.bytes) &&
            usage.requestId === ""
          ) {
            usage.requestId = fieldText(field);
          }
        } else if (field.num === 9) {
          usage.modelName = fieldText(field);
        }
      }
    }
  } catch {
    // Go returns the usage parsed so far.
  }

  return usage;
};

/** `ParseDevinFrame`: throws {@link ProtoError} on malformed payloads (callers skip such frames). */
export const parseDevinFrame = (payload: Uint8Array): DevinFrame => {
  const text: Uint8Array[] = [];
  const thinking: Uint8Array[] = [];
  const signature: Uint8Array[] = [];

  const frame: DevinFrame = {
    outputId: "",
    timestamp: 0,
    content: new Uint8Array(0),
    thinking: new Uint8Array(0),
    deltaTokens: 0,
    stopReason: 0,
    toolCalls: [],
    deltaSignature: new Uint8Array(0),
    deltaSignatureType: "",
    latency: 0,
    messageId: "",
    usage: undefined,
    dimensionGroups: [],
    unknownFields: [],
  };

  for (const field of readFields(payload)) {
    switch (field.wire) {
      case WireType.Varint:
        if (field.num === 2) frame.timestamp = field.varint;
        else if (field.num === 4) frame.deltaTokens = field.varint;
        else if (field.num === 5) frame.stopReason = field.varint;
        break;
      case WireType.Fixed64:
        if (field.num === 12) frame.latency = fieldDouble(field);
        break;
      case WireType.Bytes:
        switch (field.num) {
          case 1:
            frame.outputId = fieldText(field);
            break;
          case 2:
            frame.timestamp = parseTimestamp(field.bytes);
            break;
          case 3:
            text.push(field.bytes);
            break;
          case 6:
            try {
              frame.toolCalls.push(parseToolCallDelta(field.bytes));
            } catch {
              // A malformed tool-call delta is skipped (Go ignores its error).
            }

            break;
          case 7:
            frame.usage = parseUsage(field.bytes);
            break;
          case 9:
            thinking.push(field.bytes);
            break;
          case 10:
            signature.push(field.bytes);
            break;
          case 17:
            frame.messageId = fieldText(field);
            break;
          case 21:
            frame.deltaSignatureType = fieldText(field);
            break;
          case 28:
            frame.dimensionGroups.push(field.bytes);
            break;
          default:
            frame.unknownFields.push(field.num);
        }
    }
  }

  if (text.length > 0) frame.content = concatBytes(text);

  if (thinking.length > 0) frame.thinking = concatBytes(thinking);

  if (signature.length > 0) frame.deltaSignature = concatBytes(signature);

  return frame;
};

/**
 * `ParseDevinResponseDimensionGroups`: `Token Usage` metrics (input/output/cached tokens) of field 28 groups, used
 * when the usage field is missing or zero.
 */
export const parseDimensionGroups = (
  groups: ReadonlyArray<Uint8Array>,
):
  | {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly cachedTokens: number;
    }
  | undefined => {
  for (const original of groups) {
    if (original.length === 0) continue;
    let group = original;

    try {
      // An outer envelope carrying tag 28 is unwrapped.
      const first = readFields(group).next().value;

      if (first !== undefined && first.num === 28 && first.wire === WireType.Bytes)
        group = first.bytes;
    } catch {
      continue;
    }

    let title = "";
    const metrics: Array<{ readonly key: string; readonly value: number }> = [];

    try {
      for (const field of readFields(group)) {
        if (field.wire !== WireType.Bytes) continue;

        if (field.num === 1) title = fieldText(field);
        else if (field.num === 2) {
          let key = "";
          let value = 0;

          try {
            for (const metric of readFields(field.bytes)) {
              if (metric.wire !== WireType.Bytes) continue;

              if (metric.num === 5) key = fieldText(metric);
              else if (metric.num === 4) {
                for (const detail of readFields(metric.bytes)) {
                  if (detail.wire === WireType.Fixed32 && detail.num === 2)
                    value = fieldFloat(detail);
                }
              }
            }
          } catch {
            // Keep the partial metric.
          }

          if (key !== "") metrics.push({ key, value });
        }
      }
    } catch {
      // Keep the partial group.
    }

    if (title.toLowerCase() !== "token usage") continue;
    let found = false;
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;

    for (const metric of metrics) {
      if (metric.key === "input_tokens") [promptTokens, found] = [Math.trunc(metric.value), true];
      else if (metric.key === "output_tokens")
        [completionTokens, found] = [Math.trunc(metric.value), true];
      else if (metric.key === "cached_input_tokens")
        [cachedTokens, found] = [Math.trunc(metric.value), true];
    }

    if (found) return { promptTokens, completionTokens, cachedTokens };
  }

  return undefined;
};

/** Folds the usage of a later frame into the running total (`finalUsage` merge of the Go stream loops). */
export const mergeDevinUsage = (current: DevinUsage | undefined, next: DevinUsage): DevinUsage => {
  if (current === undefined) return next;

  if (next.promptTokens > 0) current.promptTokens = next.promptTokens;

  if (next.completionTokens > 0) current.completionTokens = next.completionTokens;

  if (next.cachedTokens > 0) current.cachedTokens = next.cachedTokens;

  if (next.cacheWriteTokens > 0) current.cacheWriteTokens = next.cacheWriteTokens;

  if (next.requestId !== "") current.requestId = next.requestId;

  if (next.modelName !== "") current.modelName = next.modelName;
  Object.assign(current.headers, next.headers);

  return current;
};

/** Fallback usage from field 28 groups (only fills zero counters). */
export const applyDimensionUsage = (
  usage: DevinUsage | undefined,
  groups: ReadonlyArray<Uint8Array>,
): DevinUsage | undefined => {
  if (groups.length === 0) return usage;

  if (
    usage !== undefined &&
    usage.promptTokens !== 0 &&
    usage.completionTokens !== 0 &&
    usage.cachedTokens !== 0
  ) {
    return usage;
  }

  const parsed = parseDimensionGroups(groups);

  if (parsed === undefined) return usage;
  const out = usage ?? emptyDevinUsage();

  if (out.promptTokens === 0) out.promptTokens = parsed.promptTokens;

  if (out.completionTokens === 0) out.completionTokens = parsed.completionTokens;

  if (out.cachedTokens === 0) out.cachedTokens = parsed.cachedTokens;

  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// Trailer
// ---------------------------------------------------------------------------------------------------------------

export interface DevinTrailerError {
  /** HTTP status the error maps to. */
  readonly status: number;
  readonly message: string;
}

/** `ParseDevinTrailerError`: the EOS trailer's `{"error":{code,message}}` mapped to an HTTP status. */
export const parseTrailerError = (payload: Uint8Array): DevinTrailerError | undefined => {
  const text = new TextDecoder().decode(payload).trim();

  if (text === "" || text === "{}") return undefined;
  const parsed = tryParseJson(text);

  if (!isJsonObject(parsed)) return undefined;
  const error = parsed["error"];

  if (!isJsonObject(error)) return undefined;

  // Go decodes into string fields: a non-string code or message is a decode failure, i.e. no error.
  if (
    (error.code !== undefined && typeof error.code !== "string") ||
    (error.message !== undefined && typeof error.message !== "string")
  ) {
    return undefined;
  }

  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  const lowerMessage = message.toLowerCase();
  let status = 502;

  switch (code.toLowerCase()) {
    case "invalid_argument":
      status = lowerMessage.includes("internal error") ? 502 : 400;
      break;
    case "internal":
      status = 502;
      break;
    case "unauthenticated":
      status = 401;
      break;
    case "permission_denied":
      status = lowerMessage.includes("high demand") ? 429 : 403;
      break;
    case "resource_exhausted":
      status = 429;
      break;
    case "unavailable":
      status = 503;
      break;
    case "canceled":
      status = 499;
      break;
    case "deadline_exceeded":
      status = 504;
      break;
    case "failed_precondition":
      status = ["quota", "credit", "acu", "exhausted", "limit"].some((word) =>
        lowerMessage.includes(word),
      )
        ? 429
        : 400;
  }

  return { status, message: `devin upstream error (${code}): ${message}` };
};

export { ProtoError };
