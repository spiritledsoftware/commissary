/**
 * Request-scoped view of an Antigravity/Gemini payload for reasoning replay.
 *
 * Go source: internal/runtime/executor/antigravity_reasoning_replay.go (`antigravityReplayRequestIndex`, the
 * incremental context fingerprints, part fingerprints, `reasoningReplayItemsFromRequest`). The index aliases the live
 * payload parts, so it must be rebuilt after every mutation (callers do, like the Go sequential path).
 * Fingerprints only have to agree between the request that produced a ledger item and the request that consumes it
 * (both are built by this module), so they use the Go recipe over canonical JSON (`stableStringify`) without being
 * byte-identical to Go's hashes.
 */
import { createHash, type Hash } from "node:crypto";
import { sha256Hex } from "@commissary/core";
import {
  asBool,
  asString,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  stableStringify,
} from "@commissary/json";

export const SIGNATURE_PATHS = [
  "thoughtSignature",
  "thought_signature",
  "extra_content.google.thought_signature",
];

export const SKIP_VALIDATOR = "skip_thought_signature_validator";

export const isModelRole = (content: Json | undefined): boolean =>
  asString(get(content, "role")).trim().toLowerCase() === "model";

/** `antigravityNativePartThoughtSignature`. */
export const nativePartThoughtSignature = (part: Json | undefined): string => {
  for (const path of SIGNATURE_PATHS) {
    const signature = asString(get(part, path)).trim();

    if (signature !== "") return signature;
  }

  return "";
};

/** `antigravityHasNativeThoughtSignature`. */
export const hasNativeThoughtSignature = (signature: string): boolean => {
  const trimmed = signature.trim();

  return trimmed !== "" && trimmed !== SKIP_VALIDATOR;
};

/** `antigravityFunctionCallKey`. */
export const functionCallKey = (name: string, args: Json | undefined, callId: string): string => {
  const trimmed = name.trim();

  if (trimmed === "") return "";
  const argsText = args === undefined ? "" : stableStringify(args);

  return `fc:${createHash("sha256").update([trimmed, argsText, callId].join("\u0000")).digest("hex").slice(0, 16)}`;
};

/** `antigravityReplayToolCallKeys` of a ledger item or a functionCall object. */
export const replayToolCallKeys = (item: Json | undefined): string[] => {
  let callId = asString(get(item, "call_id")).trim();

  if (callId === "") callId = asString(get(item, "id")).trim();
  const name = asString(get(item, "name")).trim();

  if (name === "") return [];
  const key = functionCallKey(name, get(item, "args"), callId);

  return key === "" ? [] : [key];
};

export interface PartFingerprint {
  readonly kind: string;
  readonly fingerprint: string;
}

/** `antigravityReplayPartFingerprint`: only plain text parts have one. */
export const partFingerprint = (part: Json | undefined): PartFingerprint => {
  if (get(part, "functionCall") !== undefined || get(part, "functionResponse") !== undefined) {
    return { kind: "", fingerprint: "" };
  }

  const text = get(part, "text");

  if (text === undefined) return { kind: "", fingerprint: "" };
  const kind = asBool(get(part, "thought")) ? "thought" : "text";

  return { kind, fingerprint: sha256Hex(`${kind}\u0000${asString(text)}`) };
};

/** `antigravityReplayPartOccurrence`. */
export const partOccurrence = (
  parts: ReadonlyArray<Json>,
  targetPartIndex: number,
  targetKind: string,
  targetHash: string,
): number => {
  let occurrence = 0;

  for (let index = 0; index < targetPartIndex && index < parts.length; index++) {
    const { kind, fingerprint } = partFingerprint(parts[index]);

    if (kind === targetKind && fingerprint === targetHash) occurrence++;
  }

  return occurrence;
};

export interface IndexedPart {
  readonly contentIndex: number;
  readonly partIndex: number;
  readonly part: Json;
  readonly functionCall: Json;
}

export interface IndexedContent {
  readonly content: Json;
  readonly parts: ReadonlyArray<Json>;
}

/** Version tag of the OpenAI chat context hash: legacy and non-OpenAI ledger entries keep matching the old way. */
const OPENAI_CHAT_CONTEXT_PREFIX = "openai-chat-v1:";

/**
 * Prefix hashes of the replay context (system instruction, tools, tool config, then each content). The OpenAI chat
 * variant leaves the tools and tool config out so a turn's replay is not bound to the current tool policy (80aa2b1d).
 */
class ContextFingerprints {
  readonly #valid: boolean;
  readonly #contents: ReadonlyArray<IndexedContent>;
  readonly #hash: Hash = createHash("sha256");
  readonly #sums: string[];
  #wrote = false;

  constructor(
    payload: Json,
    contents: ReadonlyArray<IndexedContent>,
    valid: boolean,
    includeToolPolicy: boolean,
  ) {
    this.#valid = valid;
    this.#contents = contents;

    if (!valid) {
      this.#sums = [""];

      return;
    }

    const paths = includeToolPolicy
      ? ["request.systemInstruction", "request.tools", "request.toolConfig"]
      : ["request.systemInstruction"];

    for (const path of paths) {
      const value = get(payload, path);

      if (value === undefined) continue;
      this.#write(path);
      this.#write("\u0000");
      this.#write(stableStringify(value));
      this.#write("\u0000");
    }

    this.#sums = [this.#sum()];
  }

  #write(text: string): void {
    if (text === "") return;
    this.#hash.update(text);
    this.#wrote = true;
  }

  /** The empty fingerprint until at least one byte was hashed (an all-empty context equals a missing one). */
  #sum(): string {
    return this.#wrote ? this.#hash.copy().digest("hex") : "";
  }

  at(beforeContentIndex: number): string {
    if (!this.#valid || beforeContentIndex < 0 || beforeContentIndex > this.#contents.length)
      return "";

    while (this.#sums.length <= beforeContentIndex) {
      const content = this.#contents[this.#sums.length - 1];

      if (content === undefined) return "";
      this.#write(asString(get(content.content, "role")).trim().toLowerCase());
      this.#write("\u0000");

      for (const part of content.parts) {
        let normalized: Json = part;

        if (isJsonObject(part)) {
          normalized = structuredClone(part);

          for (const path of SIGNATURE_PATHS) del(normalized, path);
        }

        this.#write(stableStringify(normalized));
        this.#write("\u0000");
      }

      this.#sums.push(this.#sum());
    }

    return this.#sums[beforeContentIndex] ?? "";
  }
}

export interface PendingContentPosition {
  readonly contentIndex: number;
  readonly basePartIndex: number;
}

export class RequestIndex {
  readonly validContents: boolean;
  readonly contents: IndexedContent[] = [];
  readonly #functionCallsById = new Map<string, IndexedPart>();
  readonly #functionResponseContentById = new Map<string, number>();
  readonly #fingerprints: ContextFingerprints;
  readonly #payload: Json;
  #openAIChatFingerprints: ContextFingerprints | undefined;

  constructor(payload: Json) {
    this.#payload = payload;
    const contents = get(payload, "request.contents");
    this.validContents = isJsonArray(contents);

    if (isJsonArray(contents)) {
      contents.forEach((content, contentIndex) => {
        const partsValue = get(content, "parts");
        const parts = isJsonArray(partsValue) ? partsValue : [];
        this.contents.push({ content, parts });
        parts.forEach((part, partIndex) => {
          const functionCall = get(part, "functionCall");

          if (functionCall !== undefined) {
            const callId = asString(get(functionCall, "id")).trim();

            if (callId !== "" && !this.#functionCallsById.has(callId)) {
              this.#functionCallsById.set(callId, { contentIndex, partIndex, part, functionCall });
            }
          }

          const response = get(part, "functionResponse");

          if (response !== undefined) {
            const callId = asString(get(response, "id")).trim();

            if (callId !== "" && !this.#functionResponseContentById.has(callId)) {
              this.#functionResponseContentById.set(callId, contentIndex);
            }
          }
        });
      });
    }

    this.#fingerprints = new ContextFingerprints(payload, this.contents, this.validContents, true);
  }

  functionCallPartLocation(callId: string): IndexedPart | undefined {
    return this.#functionCallsById.get(callId.trim());
  }

  functionResponseContentIndex(callId: string): number | undefined {
    return this.#functionResponseContentById.get(callId.trim());
  }

  contextFingerprint(beforeContentIndex: number): string {
    return this.#fingerprints.at(beforeContentIndex);
  }

  /** `openAIChatContextFingerprint`: system instruction and preceding contents, not the tool declarations or choice. */
  openAIChatContextFingerprint(contentIndex: number): string {
    this.#openAIChatFingerprints ??= new ContextFingerprints(
      this.#payload,
      this.contents,
      this.validContents,
      false,
    );

    return OPENAI_CHAT_CONTEXT_PREFIX + this.#openAIChatFingerprints.at(contentIndex);
  }

  /** `contextMatches`: items without a context hash always match. */
  contextMatches(item: Json, contentIndex: number): boolean {
    const expected = asString(get(item, "contextHash")).trim();

    if (expected.startsWith(OPENAI_CHAT_CONTEXT_PREFIX))
      return expected === this.openAIChatContextFingerprint(contentIndex);

    return expected === "" || expected === this.contextFingerprint(contentIndex);
  }

  /** `pendingModelContentIndex`: where the model turn being generated will land. */
  pendingModelContentIndex(): PendingContentPosition {
    const lastIndex = this.contents.length - 1;
    const last = this.contents[lastIndex];

    if (last === undefined) return { contentIndex: 0, basePartIndex: 0 };

    if (
      isModelRole(last.content) &&
      !last.parts.some((part) => get(part, "functionResponse") !== undefined)
    ) {
      return { contentIndex: lastIndex, basePartIndex: last.parts.length };
    }

    return { contentIndex: this.contents.length, basePartIndex: 0 };
  }

  /** `reasoningReplayItemsFromRequest`: ledger items describing the signed model turns the request already holds. */
  reasoningReplayItemsFromRequest(): Json[] | undefined {
    if (!this.validContents) return undefined;
    const items: Json[] = [];
    this.contents.forEach((content, contentIndex) => {
      if (!isModelRole(content.content) || content.parts.length === 0) return;
      const occurrences = new Map<string, number>();
      content.parts.forEach((part, partIndex) => {
        let signature = nativePartThoughtSignature(part);

        if (!hasNativeThoughtSignature(signature)) signature = "";
        const functionCall = get(part, "functionCall");

        if (functionCall !== undefined) {
          const key = functionCallKey(
            asString(get(functionCall, "name")),
            get(functionCall, "args"),
            "",
          );

          const occurrence = occurrences.get(key) ?? 0;

          if (key !== "") occurrences.set(key, occurrence + 1);

          const item = buildFunctionCallPartItem(
            contentIndex,
            partIndex,
            occurrence,
            functionCall,
            signature,
          );

          items.push(withContextHash(item, this.contextFingerprint(contentIndex)));

          return;
        }

        if (signature === "") return;
        let targetPartIndex = partIndex;
        let { kind, fingerprint } = partFingerprint(part);

        if (fingerprint === "" && partIndex > 0) {
          targetPartIndex = partIndex - 1;
          ({ kind, fingerprint } = partFingerprint(content.parts[targetPartIndex]));
        }

        if (fingerprint === "") return;

        const item = buildThoughtSignatureItem(
          contentIndex,
          targetPartIndex,
          signature,
          kind,
          fingerprint,
        );

        item["targetOccurrence"] = partOccurrence(
          content.parts,
          targetPartIndex,
          kind,
          fingerprint,
        );
        items.push(withContextHash(item, this.contextFingerprint(contentIndex)));
      });
    });

    return items;
  }
}

type ItemObject = JsonObject;

export const withContextHash = (item: ItemObject, contextHash: string): ItemObject => {
  if (contextHash !== "") item["contextHash"] = contextHash;

  return item;
};

/** `buildAntigravityThoughtSignatureItem`. */
export const buildThoughtSignatureItem = (
  contentIndex: number,
  partIndex: number,
  signature: string,
  targetKind: string,
  targetHash: string,
): ItemObject => {
  const item: ItemObject = {
    type: "thought_signature",
    thoughtSignature: signature,
    contentIndex,
    partIndex,
  };

  if (targetKind !== "") item["targetKind"] = targetKind;

  if (targetHash !== "") item["targetHash"] = targetHash;

  return item;
};

/** `buildAntigravityFunctionCallPartItem`. */
export const buildFunctionCallPartItem = (
  contentIndex: number,
  partIndex: number,
  targetOccurrence: number,
  functionCall: Json,
  signature: string,
): ItemObject => {
  const item: ItemObject = {
    type: "function_call_part",
    contentIndex,
    partIndex,
    targetOccurrence,
    name: asString(get(functionCall, "name")),
  };

  const id = asString(get(functionCall, "id")).trim();

  if (id !== "") item["call_id"] = id;
  const args = get(functionCall, "args");

  if (args !== undefined) item["args"] = args;

  if (signature !== "") item["thoughtSignature"] = signature;

  return item;
};
