/**
 * Claude thinking-signature validation (E / R / Q / CAIS envelopes).
 *
 * Go source: internal/signature/claude_validation.go, claude_antigravity_validation.go, claude.go and
 * `CompatibleAntigravityClaudeThinkingSignature` / `DetectSignatureProviderForBlock` (provider_compatibility.go,
 * Claude branch only). Layers: `E` = single base64 layer (decoded payload starts with 0x12), `R` = double layer,
 * `Q` = Antigravity double-layer CAQS (inner `C…`), `C` = native CAIS. The strict protobuf-tree mode is ported and
 * selected by `SignatureSettings.bypassStrictMode` (default off, like Go).
 */
import { asString, get, isJsonArray, isJsonObject, type Json } from "@commissary/json";
import {
  consumeBytes,
  consumeTag,
  consumeVarint,
  WireType,
} from "../translator/gemini/common/protowire.ts";
import {
  bytesToBinaryString,
  decodeBase64Std,
  decodeUtf8Strict,
  encodeBase64Std,
} from "./base64.ts";

export const MAX_CLAUDE_THINKING_SIGNATURE_LEN = 32 * 1024 * 1024;

export interface ClaudeSignatureValidationOptions {
  /** Legacy E/R prefix or a fully validated Q envelope. */
  readonly prefixOnly?: boolean;
  /** Prefix and base64 layers only (Q envelopes always get structural validation). */
  readonly base64Only?: boolean;
  /** Keep empty thinking placeholders (no signature, no text) when stripping. */
  readonly allowEmptySignatureWithEmptyText?: boolean;
  readonly strict?: boolean;
}

export interface ClaudeSignatureTree {
  readonly encodingLayers: number;
  readonly channelId: number;
  readonly field2: number | undefined;
  readonly modelText: string;
  readonly hasField7: boolean;
}

export interface ClaudeCaisSignatureInfo {
  readonly envelopeVersion: number;
  readonly infrastructure: number | undefined;
  readonly channelId: number;
  readonly modelText: string;
  readonly blockKind: string;
  readonly signatureInContainer: boolean;
}

class SignatureError extends Error {}

type FieldVisitor = (num: number, type: number, raw: Uint8Array) => void;

/** `walkClaudeProtobufFields`: raw field values (without tags); throws on malformed protobuf. */
const walkFields = (msg: Uint8Array, visit: FieldVisitor): void => {
  let offset = 0;

  while (offset < msg.length) {
    const tag = consumeTag(msg, offset);

    if (tag === undefined)
      throw new SignatureError("invalid Claude signature: malformed protobuf tag");
    offset += tag.length;
    let length: number | undefined;

    switch (tag.type) {
      case WireType.Varint:
        length = consumeVarint(msg, offset)?.length;
        break;
      case WireType.Fixed32:
        length = msg.length - offset >= 4 ? 4 : undefined;
        break;
      case WireType.Fixed64:
        length = msg.length - offset >= 8 ? 8 : undefined;
        break;
      case WireType.Bytes:
        length = consumeBytes(msg, offset)?.length;
        break;
      default:
        // Groups are not produced by the signature schemas; protowire would walk them, treat them as malformed.
        length = undefined;
    }

    if (length === undefined)
      throw new SignatureError(`invalid Claude signature: malformed protobuf field ${tag.num}`);
    visit(tag.num, tag.type, msg.subarray(offset, offset + length));
    offset += length;
  }
};

const varintField = (raw: Uint8Array, label: string): number => {
  const value = consumeVarint(raw, 0);

  if (value === undefined)
    throw new SignatureError(`invalid Claude signature: failed to decode ${label}`);

  return value.value;
};

const bytesField = (raw: Uint8Array, label: string): Uint8Array => {
  const value = consumeBytes(raw, 0);

  if (value === undefined)
    throw new SignatureError(`invalid Claude signature: failed to decode ${label}`);

  return value.value;
};

const extractBytesField = (msg: Uint8Array, fieldNum: number, scope: string): Uint8Array => {
  let value: Uint8Array | undefined;
  walkFields(msg, (num, type, raw) => {
    if (num !== fieldNum) return;

    if (type !== WireType.Bytes) {
      throw new SignatureError(
        `invalid Claude signature: ${scope} field ${fieldNum} must be bytes`,
      );
    }

    value = bytesField(raw, `${scope} field ${fieldNum}`);
  });

  if (value === undefined)
    throw new SignatureError(`invalid Claude signature: missing ${scope} field ${fieldNum}`);

  return value;
};

/** `stripClaudeSignaturePrefix`: trims and removes a leading `<cache prefix>#`. */
export const stripClaudeSignaturePrefix = (raw: string): string => {
  let sig = raw.trim();

  if (sig === "") return "";
  const index = sig.indexOf("#");

  if (index >= 0) sig = sig.slice(index + 1).trim();

  return sig;
};

const inspectChannelBlock = (block: Uint8Array, encodingLayers: number): ClaudeSignatureTree => {
  let channelId: number | undefined;
  let field2: number | undefined;
  let modelText = "";
  let hasField7 = false;
  walkFields(block, (num, type, raw) => {
    switch (num) {
      case 1:
        if (type !== WireType.Varint)
          throw new SignatureError(
            "invalid Claude signature: Field 2.1.1 channel_id must be varint",
          );
        channelId = varintField(raw, "Field 2.1.1 channel_id");
        break;
      case 2:
        if (type !== WireType.Varint)
          throw new SignatureError("invalid Claude signature: Field 2.1.2 field2 must be varint");
        field2 = varintField(raw, "Field 2.1.2 field2");
        break;
      case 6: {
        if (type !== WireType.Bytes)
          throw new SignatureError(
            "invalid Claude signature: Field 2.1.6 model_text must be bytes",
          );
        const text = decodeUtf8Strict(bytesField(raw, "Field 2.1.6 model_text"));

        if (text === undefined)
          throw new SignatureError(
            "invalid Claude signature: Field 2.1.6 model_text is not valid UTF-8",
          );
        modelText = text;
        break;
      }

      case 7:
        if (type !== WireType.Varint)
          throw new SignatureError("invalid Claude signature: Field 2.1.7 must be varint");
        varintField(raw, "Field 2.1.7");
        hasField7 = true;
        break;
    }
  });

  if (channelId === undefined)
    throw new SignatureError("invalid Claude signature: missing Field 2.1.1 channel_id");

  return { encodingLayers, channelId, field2, modelText, hasField7 };
};

/** `InspectClaudeSignaturePayload`. */
export const inspectClaudeSignaturePayload = (
  payload: Uint8Array,
  encodingLayers: number,
): ClaudeSignatureTree => {
  if (payload.length === 0) throw new SignatureError("invalid Claude signature: empty payload");

  if (payload[0] !== 0x12) {
    throw new SignatureError(
      `invalid Claude signature: expected first byte 0x12, got 0x${(payload[0] ?? 0).toString(16).padStart(2, "0")}`,
    );
  }

  const container = extractBytesField(payload, 2, "top-level protobuf");
  const channelBlock = extractBytesField(container, 1, "Claude Field 2 container");

  return inspectChannelBlock(channelBlock, encodingLayers);
};

const inspectSingleLayerWithLayers = (sig: string, layers: number): ClaudeSignatureTree => {
  const decoded = decodeBase64Std(sig);

  if (decoded === undefined)
    throw new SignatureError("invalid single-layer signature: base64 decode failed");

  if (decoded.length === 0)
    throw new SignatureError("invalid single-layer signature: empty after decode");

  return inspectClaudeSignaturePayload(decoded, layers);
};

/** `InspectClaudeSingleLayerSignature`. */
export const inspectClaudeSingleLayerSignature = (sig: string): ClaudeSignatureTree =>
  inspectSingleLayerWithLayers(sig, 1);

/** `InspectClaudeDoubleLayerSignature`. */
export const inspectClaudeDoubleLayerSignature = (sig: string): ClaudeSignatureTree => {
  const decoded = decodeBase64Std(sig);

  if (decoded === undefined)
    throw new SignatureError("invalid double-layer signature: base64 decode failed");

  if (decoded.length === 0)
    throw new SignatureError("invalid double-layer signature: empty after decode");

  if (decoded[0] !== 0x45)
    throw new SignatureError("invalid double-layer signature: inner does not start with 'E'");

  return inspectSingleLayerWithLayers(bytesToBinaryString(decoded), 2);
};

const isCanonicalUuid = (value: string): boolean =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);

const CAIS_MODEL_PREFIX = "claude-";

const caisUtf8 = (raw: Uint8Array, type: number, label: string): string => {
  if (type !== WireType.Bytes)
    throw new SignatureError(`invalid Claude CAIS signature: ${label} must be bytes`);
  const text = decodeUtf8Strict(bytesField(raw, label));

  if (text === undefined)
    throw new SignatureError(`invalid Claude CAIS signature: ${label} must be valid UTF-8`);

  return text;
};

const caisVarint = (raw: Uint8Array, type: number, label: string): number => {
  if (type !== WireType.Varint)
    throw new SignatureError(`invalid Claude CAIS signature: ${label} must be varint`);

  return varintField(raw, label);
};

const caisBytes = (raw: Uint8Array, type: number, label: string): Uint8Array => {
  if (type !== WireType.Bytes)
    throw new SignatureError(`invalid Claude CAIS signature: ${label} must be bytes`);

  return bytesField(raw, label);
};

/** `inspectClaudeCAISPayload`: shared by native CAIS/CAQS and the Antigravity Q gate. */
const inspectCaisPayload = (
  decoded: Uint8Array,
  rejectDuplicateMessages: boolean,
): ClaudeCaisSignatureInfo => {
  if (decoded.length === 0)
    throw new SignatureError("invalid Claude CAIS signature: empty after decode");

  if (decoded[0] !== 0x08)
    throw new SignatureError("invalid Claude CAIS signature: unexpected first byte");
  let envelopeVersion = 0;
  let container: Uint8Array | undefined;
  let haveContainer = false;
  walkFields(decoded, (num, type, raw) => {
    if (num === 1)
      envelopeVersion = caisVarint(raw, type, "CAIS top-level field 1 envelope version");
    else if (num === 2) {
      if (rejectDuplicateMessages && haveContainer)
        throw new SignatureError("invalid Antigravity CAQS signature: duplicate container");
      haveContainer = true;
      container = caisBytes(raw, type, "CAIS top-level field 2 container");
    } else if (num === 3) caisVarint(raw, type, "CAIS top-level field 3 trailer");
  });

  if (container === undefined)
    throw new SignatureError("invalid Claude CAIS signature: missing top-level field 2 container");

  let channelBlock: Uint8Array | undefined;
  let haveChannelBlock = false;
  let containerSignatureBytes: Uint8Array | undefined;
  walkFields(container, (num, type, raw) => {
    if (num === 1) {
      if (rejectDuplicateMessages && haveChannelBlock)
        throw new SignatureError("invalid Antigravity CAQS signature: duplicate channel block");
      haveChannelBlock = true;
      channelBlock = caisBytes(raw, type, "CAIS container field 1 channel block");
    } else if (num === 5)
      containerSignatureBytes = caisBytes(raw, type, "CAIS container field 5 signature bytes");
  });

  if (channelBlock === undefined)
    throw new SignatureError(
      "invalid Claude CAIS signature: missing container field 1 channel block",
    );

  let haveChannelId = false;
  let haveSignatureBytes = false;
  let haveModelText = false;
  let channelId = 0;
  let infrastructure: number | undefined;
  let modelText = "";
  let blockKind = "";
  let signatureInContainer = false;
  walkFields(channelBlock, (num, type, raw) => {
    switch (num) {
      case 1:
        channelId = caisVarint(raw, type, "CAIS channel field 1 channel_id");
        haveChannelId = true;
        break;
      case 2:
        infrastructure = caisVarint(raw, type, "CAIS channel field 2 infrastructure");
        break;
      case 3:
        caisVarint(raw, type, "CAIS channel field 3 version");
        break;
      case 5: {
        const value = caisBytes(raw, type, "CAIS channel field 5 signature bytes");

        if (value.length === 0)
          throw new SignatureError(
            "invalid Claude CAIS signature: channel field 5 signature bytes must not be empty",
          );
        haveSignatureBytes = true;
        break;
      }

      case 6: {
        const value = caisUtf8(raw, type, "CAIS channel field 6 model_text");

        if (!value.startsWith(CAIS_MODEL_PREFIX))
          throw new SignatureError(
            `invalid Claude CAIS signature: channel field 6 model_text must start with "${CAIS_MODEL_PREFIX}"`,
          );
        modelText = value;
        haveModelText = true;
        break;
      }

      case 7:
        caisVarint(raw, type, "CAIS channel field 7");
        break;
      case 8:
        blockKind = caisUtf8(raw, type, "CAIS channel field 8 block kind");
        break;
      case 11: {
        const value = caisUtf8(raw, type, "CAIS channel field 11 context id");

        if (!isCanonicalUuid(value))
          throw new SignatureError(
            "invalid Claude CAIS signature: channel field 11 context id must be a canonical UUID",
          );
        break;
      }
    }
  });

  if (
    !haveSignatureBytes &&
    envelopeVersion >= 4 &&
    containerSignatureBytes !== undefined &&
    containerSignatureBytes.length > 0
  ) {
    signatureInContainer = true;
    haveSignatureBytes = true;
  }

  if (!haveChannelId)
    throw new SignatureError("invalid Claude CAIS signature: missing channel field 1 channel_id");

  if (!haveSignatureBytes)
    throw new SignatureError("invalid Claude CAIS signature: missing signature bytes");

  if (!haveModelText && envelopeVersion < 4)
    throw new SignatureError("invalid Claude CAIS signature: missing channel field 6 model_text");

  if (envelopeVersion >= 4 && blockKind !== "thinking" && blockKind !== "narration") {
    throw new SignatureError(
      `invalid Claude CAQS signature: expected block kind "thinking" or "narration", got "${blockKind}"`,
    );
  }

  return { envelopeVersion, infrastructure, channelId, modelText, blockKind, signatureInContainer };
};

/** `InspectClaudeCAISSignature`. */
export const inspectClaudeCaisSignature = (raw: string): ClaudeCaisSignatureInfo => {
  const sig = stripClaudeSignaturePrefix(raw);

  if (sig === "") throw new SignatureError("empty signature");

  if (sig.length > MAX_CLAUDE_THINKING_SIGNATURE_LEN)
    throw new SignatureError("signature exceeds maximum length");

  if (sig[0] !== "C")
    throw new SignatureError("invalid Claude CAIS signature: expected 'C' prefix");
  const decoded = decodeBase64Std(sig);

  if (decoded === undefined)
    throw new SignatureError("invalid Claude CAIS signature: base64 decode failed");

  return inspectCaisPayload(decoded, false);
};

/** `IsValidClaudeCAISSignature`. */
export const isValidClaudeCaisSignature = (raw: string): boolean => {
  try {
    inspectClaudeCaisSignature(raw);

    return true;
  } catch {
    return false;
  }
};

/** `InspectAntigravityClaudeCAQSSignature`: the Google version-4 thinking envelope, on any channel id. */
export const inspectAntigravityClaudeCaqsSignature = (raw: string): ClaudeCaisSignatureInfo => {
  const sig = stripClaudeSignaturePrefix(raw);

  if (sig.length === 0 || sig.length > MAX_CLAUDE_THINKING_SIGNATURE_LEN) {
    throw new SignatureError("invalid Antigravity CAQS signature length");
  }

  if (sig[0] !== "Q" || /[\r\n]/.test(sig))
    throw new SignatureError("invalid Antigravity CAQS wrapper");
  const inner = decodeBase64Std(sig, true);

  if (inner === undefined) throw new SignatureError("invalid Antigravity CAQS encoding");
  const innerText = bytesToBinaryString(inner);

  if (innerText.length === 0 || innerText[0] !== "C" || /[ \t\r\n#]/.test(innerText)) {
    throw new SignatureError("invalid Antigravity CAQS inner encoding");
  }

  const decoded = decodeBase64Std(innerText, true);

  if (decoded === undefined) throw new SignatureError("invalid Antigravity CAQS inner encoding");
  const info = inspectCaisPayload(decoded, true);

  // The channel id rotates across upstream key generations (18 -> 19) and `inspectCaisPayload` already requires it
  // to be present as a varint, so only the envelope schema is checked (Go 7517549a).
  if (
    info.envelopeVersion !== 4 ||
    info.infrastructure !== 2 ||
    info.blockKind !== "thinking" ||
    !info.signatureInContainer
  ) {
    throw new SignatureError("unsupported Antigravity CAQS envelope or channel schema");
  }

  return info;
};

const isValidCaqs = (sig: string): boolean => {
  try {
    inspectAntigravityClaudeCaqsSignature(sig);

    return true;
  } catch {
    return false;
  }
};

const validateSingleLayerContent = (sig: string, layers: number, strict: boolean): void => {
  const decoded = decodeBase64Std(sig);

  if (decoded === undefined)
    throw new SignatureError("invalid single-layer signature: base64 decode failed");

  if (decoded.length === 0)
    throw new SignatureError("invalid single-layer signature: empty after decode");

  if (decoded[0] !== 0x12)
    throw new SignatureError("invalid Claude signature: expected first byte 0x12");

  if (strict) inspectClaudeSignaturePayload(decoded, layers);
};

const validateDoubleLayer = (sig: string, strict: boolean): void => {
  const decoded = decodeBase64Std(sig);

  if (decoded === undefined)
    throw new SignatureError("invalid double-layer signature: base64 decode failed");

  if (decoded.length === 0)
    throw new SignatureError("invalid double-layer signature: empty after decode");

  if (decoded[0] !== 0x45)
    throw new SignatureError("invalid double-layer signature: inner does not start with 'E'");
  validateSingleLayerContent(bytesToBinaryString(decoded), 2, strict);
};

/**
 * `NormalizeClaudeThinkingSignature`: strips any cache prefix, validates, and returns the double-layer R or Q form
 * expected by Antigravity. Throws on an invalid signature.
 */
export const normalizeClaudeThinkingSignature = (
  raw: string,
  options: ClaudeSignatureValidationOptions = {},
): string => {
  const sig = stripClaudeSignaturePrefix(raw);

  if (sig === "") throw new SignatureError("empty signature");

  if (sig.length > MAX_CLAUDE_THINKING_SIGNATURE_LEN)
    throw new SignatureError("signature exceeds maximum length");

  switch (sig[0]) {
    case "Q":
      inspectAntigravityClaudeCaqsSignature(sig);

      return sig;
    case "R":
      validateDoubleLayer(sig, options.strict === true);

      return sig;
    case "E":
      validateSingleLayerContent(sig, 1, options.strict === true);

      return encodeBase64Std(sig);
    default:
      throw new SignatureError(
        `invalid signature: expected 'E', 'R' or 'Q' prefix, got "${sig[0]}"`,
      );
  }
};

/** `NormalizeClaudeProviderNativeThinkingSignature`: the single-layer E form expected by Claude-native providers. */
export const normalizeClaudeProviderNativeThinkingSignature = (
  raw: string,
  options: ClaudeSignatureValidationOptions = {},
): string => {
  const sig = stripClaudeSignaturePrefix(raw);

  if (sig === "") throw new SignatureError("empty signature");

  if (sig.length > MAX_CLAUDE_THINKING_SIGNATURE_LEN)
    throw new SignatureError("signature exceeds maximum length");

  switch (sig[0]) {
    case "E":
      validateSingleLayerContent(sig, 1, options.strict === true);

      return sig;
    case "R": {
      validateDoubleLayer(sig, options.strict === true);
      // SAFETY: validateDoubleLayer above already decoded sig with the same decoder, so it cannot be undefined.
      const decoded = decodeBase64Std(sig) as Uint8Array;

      return bytesToBinaryString(decoded);
    }

    default:
      throw new SignatureError(`invalid signature: expected 'E' or 'R' prefix, got "${sig[0]}"`);
  }
};

/** `HasClaudeThinkingSignaturePrefix`. */
export const hasClaudeThinkingSignaturePrefix = (raw: string): boolean => {
  const sig = stripClaudeSignaturePrefix(raw);

  if (sig === "") return false;

  if (sig[0] === "Q") return isValidCaqs(sig);

  return sig[0] === "E" || sig[0] === "R";
};

/** `HasDecodableClaudeThinkingSignature`. */
export const hasDecodableClaudeThinkingSignature = (raw: string): boolean => {
  const sig = stripClaudeSignaturePrefix(raw);

  if (sig === "" || sig.length > MAX_CLAUDE_THINKING_SIGNATURE_LEN) return false;

  switch (sig[0]) {
    case "Q":
      return isValidCaqs(sig);
    case "E": {
      const decoded = decodeBase64Std(sig);

      return decoded !== undefined && decoded.length > 0;
    }

    case "R": {
      const decoded = decodeBase64Std(sig);

      if (decoded === undefined || decoded.length === 0 || decoded[0] !== 0x45) return false;
      const inner = decodeBase64Std(bytesToBinaryString(decoded));

      return inner !== undefined && inner.length > 0;
    }

    default:
      return false;
  }
};

/** `IsValidClaudeThinkingSignature`. */
export const isValidClaudeThinkingSignature = (
  raw: string,
  options: ClaudeSignatureValidationOptions = {},
): boolean => {
  if (options.prefixOnly === true) return hasClaudeThinkingSignaturePrefix(raw);

  if (options.base64Only === true) return hasDecodableClaudeThinkingSignature(raw);

  try {
    normalizeClaudeThinkingSignature(raw, options);

    return true;
  } catch {
    return false;
  }
};

/** `ValidateClaudeThinkingSignatures`: the first invalid thinking block of a Claude `messages` payload, as an error text. */
export const validateClaudeThinkingSignatures = (
  payload: Json,
  options: ClaudeSignatureValidationOptions = {},
): string | undefined => {
  const messages = get(payload, "messages");

  if (!isJsonArray(messages)) return undefined;

  for (const [i, message] of messages.entries()) {
    const content = get(message, "content");

    if (!isJsonArray(content)) continue;

    for (const [j, part] of content.entries()) {
      if (asString(get(part, "type")) !== "thinking") continue;
      const raw = asString(get(part, "signature")).trim();

      if (raw === "") return `messages[${i}].content[${j}]: missing thinking signature`;

      try {
        normalizeClaudeThinkingSignature(raw, options);
      } catch (error) {
        return `messages[${i}].content[${j}]: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  return undefined;
};

/** `claudeThinkingBlockText`. */
export const thinkingBlockText = (part: Json): string => {
  const text = get(part, "text");

  if (typeof text === "string") return text;
  const thinking = get(part, "thinking");

  if (typeof thinking === "string") return thinking;

  if (isJsonObject(thinking)) {
    const inner = thinking["text"];

    if (typeof inner === "string") return inner;
    const nested = thinking["thinking"];

    if (typeof nested === "string") return nested;
  }

  return "";
};

/** `isEmptyClaudeThinkingPlaceholder`: no signature and no thinking text. */
export const isEmptyClaudeThinkingPlaceholder = (part: Json): boolean =>
  asString(get(part, "signature")).trim() === "" && thinkingBlockText(part).trim() === "";

const shouldStripThinkingBlock = (
  part: Json,
  options: ClaudeSignatureValidationOptions,
): boolean => {
  const signature = asString(get(part, "signature"));

  if (options.allowEmptySignatureWithEmptyText === true && isEmptyClaudeThinkingPlaceholder(part))
    return false;

  return !isValidClaudeThinkingSignature(signature, options);
};

/** `StripInvalidClaudeThinkingBlocks`: drops thinking blocks with invalid signatures from `payload.messages` in place. */
export const stripInvalidClaudeThinkingBlocks = (
  payload: Json,
  options: ClaudeSignatureValidationOptions = {},
): Json => {
  const messages = get(payload, "messages");

  if (!isJsonArray(messages)) return payload;

  for (const message of messages) {
    if (!isJsonObject(message)) continue;
    const content = message["content"];

    if (!isJsonArray(content)) continue;

    const kept = content.filter(
      (part) =>
        !(asString(get(part, "type")) === "thinking" && shouldStripThinkingBlock(part, options)),
    );

    if (kept.length !== content.length) message["content"] = kept;
  }

  return payload;
};

/**
 * `StripInvalidClaudeThinkingBlocksAndEmptyMessages`: also removes messages whose content array became empty because
 * invalid thinking blocks were stripped (messages that were already empty stay untouched only when nothing changed).
 */
export const stripInvalidClaudeThinkingBlocksAndEmptyMessages = (
  payload: Json,
  options: ClaudeSignatureValidationOptions = {},
): Json => {
  const messages = get(payload, "messages");

  if (!isJsonArray(messages)) return payload;

  const before = messages.map((message) => {
    const content = get(message, "content");

    return isJsonArray(content) ? content.length : -1;
  });

  stripInvalidClaudeThinkingBlocks(payload, options);

  const changed = messages.some((message, index) => {
    const content = get(message, "content");

    return isJsonArray(content) && content.length !== before[index];
  });

  if (!changed) return payload;
  // SAFETY: get(payload, "messages") returned an array above, so payload is a JSON object.
  const root = payload as Record<string, Json>;
  root["messages"] = messages.filter((message) => {
    const content = get(message, "content");

    return !(isJsonArray(content) && content.length === 0);
  });

  return payload;
};

/** `DetectSignatureProviderForBlock(raw, claude_thinking) == claude` (GPT/Gemini branches cannot claim a Claude envelope). */
export const isClaudeProviderSignature = (raw: string): boolean => {
  const sig = raw.trim();

  if (sig === "") return false;
  const hash = sig.indexOf("#");

  if (hash >= 0) {
    const prefix = sig.slice(0, hash).trim().toLowerCase();

    if (!CLAUDE_PREFIXES.has(prefix)) return false;
    const unprefixed = sig.slice(hash + 1).trim();

    if (unprefixed.includes("#")) return false;

    return (
      isValidClaudeThinkingSignature(unprefixed, { strict: true }) ||
      isValidClaudeCaisSignature(unprefixed)
    );
  }

  if (!"CEQRg".includes(sig.charAt(0))) return false;

  return isValidClaudeCaisSignature(sig) || isValidClaudeThinkingSignature(sig, { strict: true });
};

const CLAUDE_PREFIXES = new Set([
  "claude",
  "anthropic",
  "cais",
  "claude-cais",
  "claude_cais",
  "ccmax",
  "claude-code-max",
  "claude_code_max",
]);

/**
 * `CompatibleAntigravityClaudeThinkingSignature`: the double-layer R or Q form required by Antigravity Claude
 * replay, only for signatures strictly identifiable as Claude.
 */
export const compatibleAntigravityClaudeThinkingSignature = (raw: string): string | undefined => {
  if (!isClaudeProviderSignature(raw)) return undefined;
  const hash = raw.trim().indexOf("#");
  const prefixed = hash >= 0 && CLAUDE_PREFIXES.has(raw.trim().slice(0, hash).trim().toLowerCase());

  const payload = prefixed
    ? raw
        .trim()
        .slice(hash + 1)
        .trim()
    : raw.trim();

  try {
    return normalizeClaudeThinkingSignature(payload, { strict: true });
  } catch {
    return undefined;
  }
};
