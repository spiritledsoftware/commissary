/**
 * Gemini thought-signature validation, replay policy and request sanitising.
 *
 * Go source: internal/signature/gemini_sanitize.go (SanitizeGeminiRequestThoughtSignatures,
 * SanitizeNonVertexGeminiRequestThoughtSignatures, SanitizeGeminiSystemInstruction, GeminiReplaySignatureOrBypass),
 * internal/signature/gemini_validation.go (InspectGeminiThoughtSignature, IsGeminiVertexBareTinkSignature,
 * ValidateGeminiThoughtSignatures, ValidateGeminiFunctionCallPairing), internal/signature/provider_compatibility.go
 * (SplitSignatureProviderPrefix, SignaturePayloadWithoutProviderPrefix and the Gemini row of
 * DecideSignatureCompatibility). `decideGeminiSignature` is the Gemini-target specialisation of the decision table in
 * `provider.ts`: detecting Claude/GPT/Kimi/Grok signatures never changes the outcome for a Gemini target (they are
 * neither Gemini nor the bypass sentinel, so they are replaced/dropped); `test/signature-fixtures.test.ts` checks it
 * against Go for every sample. Debug logging is not ported.
 */
import {
  asBool,
  asString,
  del,
  exists,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  set,
} from "@commissary/json";
import { isValidClaudeCaisSignature } from "./claude.ts";
import {
  consumeBytes,
  consumeFixed,
  consumeTag,
  consumeVarint,
  WireType,
} from "../translator/gemini/common/protowire.ts";

export const GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator";

export const GEMINI_CONTEXT_ENGINEERING_BYPASS = "context_engineering_is_the_way_to_go";

const MAX_GEMINI_THOUGHT_SIGNATURE_LEN = 32 * 1024 * 1024;

export type SignatureBlockKind = "unknown" | "gemini_model_part" | "gemini_function_call";

/** `IsGeminiThoughtSignatureBypass`. */
export const isGeminiThoughtSignatureBypass = (raw: string): boolean => {
  const sig = raw.trim();

  return (
    sig === GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR || sig === GEMINI_CONTEXT_ENGINEERING_BYPASS
  );
};

const CACHE_PREFIXES = new Map<string, string>([
  ["claude", "claude"],
  ["anthropic", "claude"],
  ["cais", "claude"],
  ["claude-cais", "claude"],
  ["claude_cais", "claude"],
  ["ccmax", "claude"],
  ["claude-code-max", "claude"],
  ["claude_code_max", "claude"],
  ["gemini", "gemini"],
  ["google", "gemini"],
  ["openai", "gpt"],
  ["gpt", "gpt"],
  ["codex", "gpt"],
  ["swe", "swe"],
  ["sealed", "swe"],
]);

/** `SplitSignatureProviderPrefix`: this repo's `provider#payload` cache envelope. */
const splitProviderPrefix = (raw: string): { provider: string; unprefixed: string } | undefined => {
  const trimmed = raw.trim();
  const index = trimmed.indexOf("#");

  if (index < 0) return undefined;
  const provider = CACHE_PREFIXES.get(trimmed.slice(0, index).trim().toLowerCase());

  return provider === undefined
    ? undefined
    : { provider, unprefixed: trimmed.slice(index + 1).trim() };
};

/** `SignaturePayloadWithoutProviderPrefix`. */
export const signaturePayloadWithoutProviderPrefix = (raw: string): string =>
  splitProviderPrefix(raw)?.unprefixed ?? raw.trim();

const decodeBase64 = (sig: string): Uint8Array | undefined => {
  if (sig.length > MAX_GEMINI_THOUGHT_SIGNATURE_LEN) return undefined;
  const text = sig.replace(/[\r\n]/g, "");

  // StdEncoding requires padding, RawStdEncoding forbids it.
  if (text.includes("=")) {
    if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={1,2}$/.test(text)) return undefined;
  } else if (text.length % 4 === 1 || !/^[A-Za-z0-9+/]*$/.test(text)) {
    return undefined;
  }

  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);

    return out;
  } catch {
    return undefined;
  }
};

const isAsciiUuid = (bytes: Uint8Array): boolean => {
  if (bytes.length !== 36) return false;

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;

    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (b !== 0x2d) return false;
    } else if (
      !((b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66) || (b >= 0x41 && b <= 0x46))
    ) {
      return false;
    }
  }

  return true;
};

/** Tink prefix-type byte of the opaque ciphertext. */
const isLikelyOpaquePayload = (value: Uint8Array): boolean => value.length > 0 && value[0] === 0x01;

/** Server-side tool blocks wrap the Tink ciphertext in a protobuf message with a bytes field starting with 0x01. */
const isLikelyToolInvocationPayload = (value: Uint8Array): boolean => {
  if (value.length === 0) return false;
  let offset = 0;
  let hasTink = false;

  while (offset < value.length) {
    const tag = consumeTag(value, offset);

    if (tag === undefined) return false;
    offset += tag.length;

    switch (tag.type) {
      case WireType.Varint: {
        const v = consumeVarint(value, offset);

        if (v === undefined) return false;
        offset += v.length;
        break;
      }

      case WireType.Bytes: {
        const b = consumeBytes(value, offset);

        if (b === undefined) return false;
        offset += b.length;

        if (isLikelyOpaquePayload(b.value)) hasTink = true;
        break;
      }

      case WireType.Fixed32:
      case WireType.Fixed64: {
        const width = consumeFixed(value, offset, tag.type === WireType.Fixed32 ? 4 : 8);

        if (width === undefined) return false;
        offset += width;
        break;
      }

      default:
        return false;
    }
  }

  return hasTink && offset === value.length;
};

/** `consumeGeminiField2Field1Value`: field 2 (bytes) holding exactly one field-1 (bytes) record. */
const field2Field1Value = (decoded: Uint8Array): Uint8Array | undefined => {
  const tag = consumeTag(decoded, 0);

  if (tag === undefined || tag.num !== 2 || tag.type !== WireType.Bytes) return undefined;
  const container = consumeBytes(decoded, tag.length);

  if (container === undefined || tag.length + container.length !== decoded.length) return undefined;
  const inner = consumeTag(container.value, 0);

  if (inner === undefined || inner.num !== 1 || inner.type !== WireType.Bytes) return undefined;
  const value = consumeBytes(container.value, inner.length);

  if (value === undefined || inner.length + value.length !== container.value.length)
    return undefined;

  return value.value;
};

/** `geminiBareTinkMinLen`: prefix-type byte, four-byte key id and a 16-byte authentication tag. */
const BARE_TINK_MIN_LEN = 1 + 4 + 16;

/**
 * `geminiVertexBareTinkKeyIDs`: the Tink key ids observed on the Vertex serve path. Without a protobuf wrapper the
 * ciphertext is indistinguishable from uniform random bytes, so the prefix byte alone would claim about 1/256 of any
 * unenveloped payload (xAI `encrypted_content`, Kimi signatures). A rotated key is not recognised and falls back to the
 * bypass sentinel; add the new id when it is observed (Go a8582fba).
 */
const VERTEX_BARE_TINK_KEY_IDS: ReadonlyArray<ReadonlyArray<number>> = [[0x8f, 0x3d, 0x6b, 0x5f]];

/**
 * `isGeminiBareTinkEnvelope`: the unwrapped Tink primitive output the Vertex serve path emits as the whole
 * `thoughtSignature` (byte 0 = 0x01, bytes 1..4 = key id, then ciphertext).
 */
const isBareTinkEnvelope = (decoded: Uint8Array): boolean =>
  decoded.length >= BARE_TINK_MIN_LEN &&
  decoded[0] === 0x01 &&
  VERTEX_BARE_TINK_KEY_IDS.some((keyId) => keyId.every((byte, i) => decoded[1 + i] === byte));

type GeminiEnvelope = "protobuf_field_2" | "bare_tink";

/** `classifyGeminiThoughtSignatureEnvelope`: the known envelope of a Gemini signature, or `undefined`. */
const geminiEnvelopeOf = (raw: string): GeminiEnvelope | undefined => {
  const sig = raw.trim();

  if (sig === "" || isGeminiThoughtSignatureBypass(sig)) return undefined;
  const decoded = decodeBase64(sig);

  if (decoded === undefined || decoded.length === 0) return undefined;

  if (isAsciiUuid(decoded)) return undefined;
  const value = field2Field1Value(decoded);

  if (
    value !== undefined &&
    (isLikelyOpaquePayload(value) || isAsciiUuid(value) || isLikelyToolInvocationPayload(value))
  ) {
    return "protobuf_field_2";
  }

  return isBareTinkEnvelope(decoded) ? "bare_tink" : undefined;
};

/** `IsValidGeminiThoughtSignature(sig, {RequireKnownEnvelope: true})` (the bypass sentinel is not accepted here). */
export const isKnownGeminiEnvelope = (raw: string): boolean => geminiEnvelopeOf(raw) !== undefined;

/**
 * `IsGeminiVertexBareTinkSignature`: `raw` (with or without a cache prefix) is a Vertex bare-Tink thought signature.
 * Only Vertex accepts it; Antigravity, AI Studio and the Gemini API answer 400 "Corrupted thought signature", so
 * callers sending anywhere else must treat it as incompatible (Go 1398f273).
 */
export const isGeminiVertexBareTinkSignature = (raw: string): boolean => {
  const sig = signaturePayloadWithoutProviderPrefix(raw);

  return !isValidClaudeCaisSignature(sig) && geminiEnvelopeOf(sig) === "bare_tink";
};

type Detected = "gemini" | "gemini_bypass" | "other";

/** `DetectSignatureProviderForBlock` reduced to "is this a Gemini-replayable signature". */
const detectForGemini = (raw: string): Detected => {
  const sig = raw.trim();

  if (sig === "") return "other";
  const prefixed = splitProviderPrefix(sig);

  if (prefixed !== undefined) {
    if (prefixed.provider !== "gemini" || prefixed.unprefixed.includes("#")) return "other";

    if (isGeminiThoughtSignatureBypass(prefixed.unprefixed)) return "gemini_bypass";

    return isKnownGeminiEnvelope(prefixed.unprefixed) ? "gemini" : "other";
  }

  if (sig.includes("#")) return "other";

  if (isGeminiThoughtSignatureBypass(sig)) return "gemini_bypass";

  return isKnownGeminiEnvelope(sig) ? "gemini" : "other";
};

export interface GeminiSignatureDecision {
  readonly action: "preserve" | "replace_with_gemini_bypass";
  /** Replayable signature (payload without cache prefix) when `action` is `preserve`. */
  readonly normalized: string;
}

/** `DecideSignatureCompatibility(Gemini, raw, blockKind)` (every Gemini block kind shares the same outcome). */
export const decideGeminiSignature = (raw: string): GeminiSignatureDecision => {
  if (detectForGemini(raw) !== "other") {
    const payload = signaturePayloadWithoutProviderPrefix(raw);

    if (isGeminiThoughtSignatureBypass(payload) || isKnownGeminiEnvelope(payload)) {
      return { action: "preserve", normalized: payload };
    }
  }

  return { action: "replace_with_gemini_bypass", normalized: "" };
};

/** `CompatibleSignatureForProviderBlock(Gemini, raw, kind)`: the replayable signature, or `undefined`. */
export const compatibleGeminiSignature = (raw: string): string | undefined => {
  const decision = decideGeminiSignature(raw);

  return decision.action === "preserve" && decision.normalized !== ""
    ? decision.normalized
    : undefined;
};

/** `SignatureProviderFromModelName(model) == SignatureProviderGemini`. */
export const isGeminiSignatureModel = (modelName: string): boolean => {
  const lower = modelName.trim().toLowerCase();

  return !lower.includes("claude") && lower.includes("gemini");
};

/** `sigcompat.MaxGeminiThoughtSignatureLen`. */
export const MAX_GEMINI_SIGNATURE_LEN = MAX_GEMINI_THOUGHT_SIGNATURE_LEN;

/** `geminiSanitizeOptions`: the replay policy scoped to the upstream endpoint. */
interface GeminiSanitizeOptions {
  /** Vertex bare-Tink is incompatible: Antigravity and the Gemini API reject it as a corrupted signature. */
  readonly rejectBareTink: boolean;
}

/** `geminiSanitizeDecision`: endpoint scoping on top of the family-level decision. */
const endpointDecision = (raw: string, options: GeminiSanitizeOptions): GeminiSignatureDecision => {
  const decision = decideGeminiSignature(raw);

  if (
    !options.rejectBareTink ||
    decision.action !== "preserve" ||
    !isGeminiVertexBareTinkSignature(raw)
  ) {
    return decision;
  }

  return { action: "replace_with_gemini_bypass", normalized: "" };
};

const replayOrBypass = (raw: string, options: GeminiSanitizeOptions): string => {
  const decision = endpointDecision(raw, options);

  return decision.action === "preserve" && decision.normalized !== ""
    ? decision.normalized
    : GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR;
};

/** `GeminiReplaySignatureOrBypass`. */
export const geminiReplaySignatureOrBypass = (raw: string): string =>
  replayOrBypass(raw, { rejectBareTink: false });

const SIGNATURE_PATHS = [
  "thoughtSignature",
  "thought_signature",
  "functionCall.thoughtSignature",
  "functionCall.thought_signature",
  "functionResponse.thoughtSignature",
  "functionResponse.thought_signature",
  "extra_content.google.thought_signature",
] as const;

interface PartThoughtSignature {
  readonly raw: string;
  readonly has: boolean;
}

const partThoughtSignature = (part: Json): PartThoughtSignature => {
  for (const path of SIGNATURE_PATHS) {
    const value = get(part, path);

    if (value !== undefined) {
      const found: PartThoughtSignature = { raw: asString(value), has: true };

      return found;
    }
  }

  const missing: PartThoughtSignature = { raw: "", has: false };

  return missing;
};

const hasNormalizedSignature = (part: Json, replay: string): boolean => {
  if (!isJsonObject(part) || part["thoughtSignature"] !== replay) return false;

  return SIGNATURE_PATHS.slice(1).every((path) => !exists(part, path));
};

const deleteSignatureFields = (part: Json): void => {
  for (const path of SIGNATURE_PATHS) del(part, path);
};

const hasServerToolBlock = (part: Json): boolean =>
  ["toolCall", "tool_call", "toolResponse", "tool_response"].some((key) => exists(part, key));

const isEmptyPartObject = (part: Json): boolean =>
  isJsonObject(part) && Object.keys(part).length === 0;

/**
 * `SanitizeGeminiSystemInstruction`: removes empty part objects (`{}`) from `systemInstruction.parts` and
 * `system_instruction.parts` at the envelope level of `contentsPath`, and drops the instruction itself when nothing
 * is left: upstream protobuf validation rejects a Part whose `data` oneof is unset (CLIProxyAPI 4c46f0aa).
 */
export const sanitizeGeminiSystemInstruction = (payload: Json, contentsPath: string): Json => {
  const trimmed = contentsPath.trim();
  const dot = trimmed.lastIndexOf(".");
  const prefix = dot > 0 ? trimmed.slice(0, dot + 1) : "";

  for (const key of ["systemInstruction", "system_instruction"]) {
    const path = `${prefix}${key}`;
    const parts = get(get(payload, path), "parts");

    if (!isJsonObject(get(payload, path)) || !isJsonArray(parts)) continue;
    const kept = parts.filter((part) => !isEmptyPartObject(part));

    if (kept.length === parts.length) continue;

    if (kept.length === 0) del(payload, path);
    else set(payload, `${path}.parts`, kept);
  }

  return payload;
};

/**
 * `SanitizeGeminiRequestThoughtSignatures`: applies the Gemini replay policy in place to `payload[contentsPath]`
 * (`contents` or `request.contents`). Provider signatures stay on their parts, only a missing/incompatible *first*
 * functionCall of each parallel-call group (the start of a model turn, or after a non-thought part) gets the bypass
 * sentinel, sibling calls stay unsigned and functionResponse parts never carry signatures. Returns `payload`.
 *
 * Vertex bare-Tink signatures are preserved because the target endpoint is not known here; the executors of every other
 * Gemini endpoint also call `sanitizeNonVertexGeminiRequestThoughtSignatures` before sending.
 */
export const sanitizeGeminiRequestThoughtSignatures = (
  payload: Json,
  contentsPath = "contents",
): Json => sanitizeThoughtSignatures(payload, contentsPath, { rejectBareTink: false });

/**
 * `SanitizeNonVertexGeminiRequestThoughtSignatures`: the same policy for Gemini endpoints other than Vertex AI
 * (Antigravity, the Gemini API). A Vertex bare-Tink signature is incompatible there: the first functionCall of a group
 * gets the bypass sentinel and other parts drop it (Go 1398f273).
 */
export const sanitizeNonVertexGeminiRequestThoughtSignatures = (
  payload: Json,
  contentsPath = "contents",
): Json => sanitizeThoughtSignatures(payload, contentsPath, { rejectBareTink: true });

const sanitizeThoughtSignatures = (
  payload: Json,
  contentsPath: string,
  options: GeminiSanitizeOptions,
): Json => {
  const path = contentsPath.trim() === "" ? "contents" : contentsPath.trim();
  sanitizeGeminiSystemInstruction(payload, path);
  const contents = get(payload, path);

  if (!isJsonArray(contents)) return payload;

  for (const content of contents) {
    const parts = get(content, "parts");

    if (!isJsonArray(parts)) continue;
    const isModelTurn = asString(get(content, "role")) === "model";
    let firstFunctionCallSeen = false;

    for (const part of parts) {
      const { raw, has } = partThoughtSignature(part);

      if (exists(part, "functionResponse")) {
        if (has) deleteSignatureFields(part);
        continue;
      }

      if (!isModelTurn || hasServerToolBlock(part)) continue;
      const hasFunctionCall = exists(part, "functionCall");
      const isFirstFunctionCall = hasFunctionCall && !firstFunctionCallSeen;

      // A text part, even an empty signature carrier, ends the parallel group: the Gemini API rejects an unsigned
      // functionCall after it. Thought parts do not (Go e5434f65).
      if (hasFunctionCall || !asBool(get(part, "thought"))) firstFunctionCallSeen = hasFunctionCall;

      if (!hasFunctionCall && !has) continue;

      const decision = endpointDecision(raw, options);
      let replay = "";

      if (isFirstFunctionCall) replay = replayOrBypass(raw, options);
      else if (
        has &&
        decision.action === "preserve" &&
        !isGeminiThoughtSignatureBypass(signaturePayloadWithoutProviderPrefix(raw))
      ) {
        replay = decision.normalized;
      }

      if (replay !== "") {
        if (!hasNormalizedSignature(part, replay)) {
          deleteSignatureFields(part);
          set(part, "thoughtSignature", replay);
        }
      } else if (has) {
        deleteSignatureFields(part);
      }
    }
  }

  return payload;
};

export interface GeminiSignatureValidationOptions {
  /** Accept Gemini's documented synthetic-history bypass sentinels. */
  readonly allowBypassSentinel?: boolean;
  /** Require the decoded payload to match a known replay-safe envelope. */
  readonly requireKnownEnvelope?: boolean;
  /** Require the decoded payload to start with the observed protobuf marker 0x12. */
  readonly requireObservedMarker?: boolean;
}

/**
 * `InspectGeminiThoughtSignature`: the local transport-shape error text for `raw` under `options`, or `undefined`
 * when the signature is acceptable. Go's wrapped base64 error text is not reproduced.
 */
export const inspectGeminiThoughtSignature = (
  raw: string,
  options: GeminiSignatureValidationOptions = {},
): string | undefined => {
  const sig = raw.trim();

  if (sig === "") return "empty Gemini thought signature";

  if (isValidClaudeCaisSignature(sig))
    return "invalid Gemini thought signature: detected Claude CAIS signature";

  if (isGeminiThoughtSignatureBypass(sig)) {
    return options.allowBypassSentinel === true
      ? undefined
      : "Gemini thought signature bypass sentinel is not allowed";
  }

  if (sig.length > MAX_GEMINI_THOUGHT_SIGNATURE_LEN) {
    return `Gemini thought signature exceeds maximum length (${MAX_GEMINI_THOUGHT_SIGNATURE_LEN} bytes)`;
  }

  const decoded = decodeBase64(sig);

  if (decoded === undefined) return "invalid Gemini thought signature: base64 decode failed";

  if (decoded.length === 0) return "invalid Gemini thought signature: empty decoded payload";

  if (options.requireKnownEnvelope === true && !isKnownGeminiEnvelope(sig)) {
    return `invalid Gemini thought signature: unknown envelope "${isAsciiUuid(decoded) ? "ascii_uuid" : "unknown"}"`;
  }

  if (options.requireObservedMarker === true && decoded[0] !== 0x12) {
    return `invalid Gemini thought signature: expected observed marker 0x12, got 0x${(decoded[0] ?? 0).toString(16).padStart(2, "0")}`;
  }

  return undefined;
};

/** `IsValidGeminiThoughtSignature`. */
export const isValidGeminiThoughtSignature = (
  raw: string,
  options: GeminiSignatureValidationOptions = {},
): boolean => inspectGeminiThoughtSignature(raw, options) === undefined;

/** `geminiContents`: `contents`, else `request.contents`. */
const geminiContents = (
  payload: Json,
): { readonly contents: Json | undefined; readonly path: string } => {
  const contents = get(payload, "contents");

  return contents !== undefined
    ? { contents, path: "contents" }
    : { contents: get(payload, "request.contents"), path: "request.contents" };
};

/**
 * `ValidateGeminiThoughtSignatures`: the first violation of the Gemini signature rules in a native payload (the first
 * functionCall of every parallel-call group of a model turn needs a valid signature or allowed sentinel; sibling calls may be unsigned but
 * never carry an invalid one), or `undefined`.
 */
export const validateGeminiThoughtSignatures = (
  payload: Json,
  options: GeminiSignatureValidationOptions = {},
): string | undefined => {
  const { contents, path } = geminiContents(payload);

  if (!isJsonArray(contents)) return undefined;

  for (const [i, content] of contents.entries()) {
    const parts = get(content, "parts");

    if (!isJsonArray(parts)) continue;
    const isModelTurn = asString(get(content, "role")).trim().toLowerCase() === "model";
    let firstFunctionCallSeen = false;

    for (const [j, part] of parts.entries()) {
      const hasFunctionCall = exists(part, "functionCall");
      const isFirstFunctionCall = isModelTurn && hasFunctionCall && !firstFunctionCallSeen;

      if (isModelTurn && (hasFunctionCall || !asBool(get(part, "thought")))) {
        firstFunctionCallSeen = hasFunctionCall;
      }

      const { raw, has } = partThoughtSignature(part);

      if (!hasFunctionCall && !has) continue;
      const partPath = `${path}[${i}].parts[${j}]`;
      const signature = raw.trim();

      if (exists(part, "functionResponse") && has) {
        return `${partPath}: functionResponse must not carry thoughtSignature`;
      }

      if (signature === "") {
        if (isFirstFunctionCall)
          return `${partPath}: missing thoughtSignature on first functionCall`;

        if (has) return `${partPath}: empty thoughtSignature`;
        continue;
      }

      if (isGeminiThoughtSignatureBypass(signature) && !isFirstFunctionCall) {
        return `${partPath}: Gemini bypass sentinel is allowed only on the first model functionCall`;
      }

      if (!hasNormalizedSignature(part, signature)) {
        return `${partPath}: thoughtSignature must use one canonical top-level field`;
      }

      const error = inspectGeminiThoughtSignature(signature, options);

      if (error !== undefined) return `${partPath}: ${error}`;
    }
  }

  return undefined;
};

interface FunctionCallRef {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/**
 * `ValidateGeminiFunctionCallPairing`: id/name pairing of functionCall and functionResponse parts; responses must not
 * share a content with calls. A final pending functionCall group is allowed (a freshly returned model step).
 */
export const validateGeminiFunctionCallPairing = (payload: Json): string | undefined => {
  const { contents, path } = geminiContents(payload);

  if (!isJsonArray(contents)) return undefined;
  let pending: readonly FunctionCallRef[] = [];

  for (const [i, content] of contents.entries()) {
    const parts = get(content, "parts");

    if (!isJsonArray(parts) || parts.length === 0) {
      if (pending.length > 0) {
        return `${path}[${i}]: content appears before ${pending.length} pending functionResponse part(s)`;
      }

      continue;
    }

    const calls: FunctionCallRef[] = [];
    const responses: Array<{ readonly part: Json; readonly path: string }> = [];

    for (const [j, part] of parts.entries()) {
      const partPath = `${path}[${i}].parts[${j}]`;
      const call = get(part, "functionCall");

      if (call !== undefined) {
        const name = asString(get(call, "name"));

        if (name === "") return `${partPath}: missing functionCall.name`;
        calls.push({ id: asString(get(call, "id")), name, path: partPath });
      }

      if (exists(part, "functionResponse")) responses.push({ part, path: partPath });
    }

    if (calls.length > 0 && responses.length > 0) {
      return `${path}[${i}]: functionCall and functionResponse parts must not be interleaved in the same content`;
    }

    if (calls.length > 0) {
      if (pending.length > 0) {
        return `${path}[${i}]: functionCall appears before ${pending.length} pending functionResponse part(s)`;
      }

      pending = calls;
      continue;
    }

    if (responses.length === 0) {
      // Intervening user content (reminders, developer notices) may precede the pending functionResponse turn; a
      // model turn without responses breaks turn ownership.
      if (pending.length > 0 && asString(get(content, "role")).trim().toLowerCase() === "model") {
        return `${path}[${i}]: model content appears before ${pending.length} pending functionResponse part(s)`;
      }

      continue;
    }

    if (pending.length === 0)
      return `${path}[${i}]: functionResponse without preceding functionCall`;

    if (responses.length !== pending.length) {
      return `${path}[${i}]: functionResponse count ${responses.length} does not match pending functionCall count ${pending.length}`;
    }

    for (const [index, response] of responses.entries()) {
      const call = pending[index];

      if (call === undefined) continue;
      const body = get(response.part, "functionResponse");
      const responseId = asString(get(body, "id"));
      const responseName = asString(get(body, "name"));

      if (call.id !== "" && responseId === "")
        return `${response.path}: missing functionResponse.id for ${call.path}`;

      if (call.id !== "" && responseId !== call.id) {
        return `${response.path}: functionResponse.id ${goQuote(responseId)} does not match functionCall.id ${goQuote(call.id)} at ${call.path}`;
      }

      if (responseName === "") return `${response.path}: missing functionResponse.name`;

      if (call.name !== "" && responseName !== call.name) {
        return `${response.path}: functionResponse.name ${goQuote(responseName)} does not match functionCall.name ${goQuote(call.name)} at ${call.path}`;
      }
    }

    pending = [];
  }

  return undefined;
};

/** `%q` for the ASCII identifiers that appear in pairing errors. */
const goQuote = (value: string): string => JSON.stringify(value);
