/**
 * Collects the signatures and function calls of one upstream response into ledger items.
 *
 * Go source: internal/runtime/executor/antigravity_reasoning_replay.go (`antigravityReasoningReplayAccumulator`:
 * `ObserveSSELine`, `observeResponsePayload`, `flushPendingThoughtSignaturesForKind`, `appendPendingThoughtSignatures`,
 * `Commit`). The ledger is only updated by a response that reached a finish reason; an oversized or empty result
 * clears the entry instead of publishing a partial chain.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import {
  asBool,
  asInt,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  tryParseJson,
} from "@commissary/json";
import {
  buildFunctionCallPartItem,
  buildThoughtSignatureItem,
  functionCallKey,
  hasNativeThoughtSignature,
  nativePartThoughtSignature,
  partFingerprint,
  replayToolCallKeys,
  RequestIndex,
  withContextHash,
} from "./request-index.ts";
import {
  type LedgerSnapshot,
  REPLAY_MAX_BYTES_PER_ENTRY,
  REPLAY_MAX_ITEMS_PER_ENTRY,
  type ReplayLedger,
} from "./ledger.ts";

/** The cache scope of a request: model, session key and the snapshot the request read. */
export interface ReplayScope {
  readonly modelName: string;
  readonly sessionKey: string;
  readonly snapshot: LedgerSnapshot;
  /** The request came from an OpenAI chat client: its context hashes leave out the tool policy (80aa2b1d). */
  readonly openAIChat?: boolean;
}

export const NO_REPLAY_SCOPE: ReplayScope = {
  modelName: "",
  sessionKey: "",
  snapshot: { loaded: false, generation: 0 },
};

export const replayScopeValid = (scope: ReplayScope): boolean =>
  scope.modelName.trim() !== "" && scope.sessionKey.trim() !== "";

interface PendingSignature {
  readonly signature: string;
  targetKind: string;
}

type Item = Record<string, Json>;

export class ReplayAccumulator {
  readonly #scope: ReplayScope;
  readonly #responseContextHash: string;
  readonly #items: Item[];
  readonly #seenFunctionCalls = new Set<string>();
  readonly #seenSignatures: Set<string>;
  readonly #segmentOccurrences: Map<string, number>;
  readonly #functionCallOccurrences: Map<string, number>;
  readonly #contentIndex: number;
  #nextPartIndex: number;
  #visibleText = "";
  #thoughtText = "";
  #visiblePartIndex = -1;
  #thoughtPartIndex = -1;
  #lastResponseKind = "";
  #pending: PendingSignature[] = [];
  #itemBytes: number;
  #overflow: boolean;
  #terminal = false;
  #committed = false;

  constructor(scope: ReplayScope, requestPayload: Json) {
    this.#scope = scope;
    const index = new RequestIndex(requestPayload);
    const { contentIndex, basePartIndex } = index.pendingModelContentIndex();
    const items: Item[] = (index.reasoningReplayItemsFromRequest() ?? []).filter(isJsonObject);
    this.#items = items;
    this.#seenSignatures = new Set(
      items.flatMap((item) => {
        const signature = asString(item["thoughtSignature"]).trim();

        return signature === "" ? [] : [signature];
      }),
    );
    this.#itemBytes = items.reduce((total, item) => total + JSON.stringify(item).length, 0);
    this.#segmentOccurrences = new Map();
    this.#functionCallOccurrences = new Map();
    const content = index.contents[contentIndex];

    for (const part of content?.parts ?? []) {
      const call = get(part, "functionCall");

      if (call !== undefined) {
        const key = functionCallKey(asString(get(call, "name")), get(call, "args"), "");

        if (key !== "")
          this.#functionCallOccurrences.set(key, (this.#functionCallOccurrences.get(key) ?? 0) + 1);
        continue;
      }

      const { kind, fingerprint } = partFingerprint(part);

      if (fingerprint !== "") {
        const key = `${kind}\u0000${fingerprint}`;
        this.#segmentOccurrences.set(key, (this.#segmentOccurrences.get(key) ?? 0) + 1);
      }
    }

    this.#contentIndex = contentIndex;
    this.#nextPartIndex = basePartIndex;
    this.#responseContextHash = scope.openAIChat
      ? index.openAIChatContextFingerprint(contentIndex)
      : index.contextFingerprint(contentIndex);

    if (scope.openAIChat) {
      items.forEach((item, itemIndex) => {
        items[itemIndex] = withContextHash(
          item,
          index.openAIChatContextFingerprint(asInt(item["contentIndex"])),
        );
      });
    }

    this.#overflow =
      items.length > REPLAY_MAX_ITEMS_PER_ENTRY || this.#itemBytes > REPLAY_MAX_BYTES_PER_ENTRY;
  }

  /** A finish reason was seen: the response completed. */
  get terminal(): boolean {
    return this.#terminal;
  }

  get committed(): boolean {
    return this.#committed;
  }

  #appendItem(item: Item): void {
    if (this.#overflow) return;
    const size = JSON.stringify(item).length;

    if (
      this.#items.length + 1 > REPLAY_MAX_ITEMS_PER_ENTRY ||
      this.#itemBytes + size > REPLAY_MAX_BYTES_PER_ENTRY
    ) {
      this.#overflow = true;

      return;
    }

    this.#items.push(item);
    this.#itemBytes += size;
  }

  #attachDetachedSignatureToLastFunctionCall(signature: string): void {
    if (signature === "") return;

    for (let index = this.#items.length - 1; index >= 0; index--) {
      const item = this.#items[index];

      if (item?.["type"] !== "function_call_part") continue;

      if (asString(item["thoughtSignature"]).trim() !== "") return;
      const delta = JSON.stringify(signature).length + `,"thoughtSignature":`.length;

      if (this.#itemBytes + delta > REPLAY_MAX_BYTES_PER_ENTRY) {
        this.#overflow = true;

        return;
      }

      item["thoughtSignature"] = signature;
      this.#itemBytes += delta;

      return;
    }
  }

  /** `ObserveSSELine`: a raw SSE `data:` line or a JSON line. */
  observeLine(line: string): void {
    let text = line.trim();

    if (text === "" || text === "[DONE]" || text.startsWith("event:")) return;

    if (text.startsWith("data:")) text = text.slice(5).trim();

    if (!text.startsWith("{")) return;
    const payload = tryParseJson(text);

    if (payload !== undefined) this.observePayload(payload);
  }

  /** `cacheAntigravityReasoningReplayFromResponse`: a non-stream body is complete even without a finishReason. */
  observeCompleted(payload: Json): void {
    this.observePayload(payload);

    if (
      !this.#terminal &&
      (get(payload, "response.candidates.0") !== undefined ||
        get(payload, "candidates.0") !== undefined)
    )
      this.#terminal = true;
  }

  observePayload(payload: Json): void {
    // The candidates sit under `response` on the wire and at the top level in a bare Gemini body (da21f1e5).
    const finishReason =
      asString(get(payload, "response.candidates.0.finishReason")).trim() ||
      asString(get(payload, "candidates.0.finishReason")).trim();

    if (finishReason !== "") this.#terminal = true;
    let parts = get(payload, "response.candidates.0.content.parts");

    if (!isJsonArray(parts)) parts = get(payload, "candidates.0.content.parts");

    if (!isJsonArray(parts)) return;

    for (const part of parts) this.#observePart(part);
  }

  #observePart(part: Json): void {
    const partIndex = this.#nextPartIndex++;
    let signature = nativePartThoughtSignature(part);

    if (!hasNativeThoughtSignature(signature)) signature = "";
    const functionCall = get(part, "functionCall");

    if (functionCall !== undefined) {
      this.#observeFunctionCall(functionCall, partIndex, signature);

      return;
    }

    let targetKind = asBool(get(part, "thought")) ? "thought" : "";
    const text = get(part, "text");
    const hasSemanticText = text !== undefined && asString(text) !== "";
    const signatureOnly = signature !== "" && !hasSemanticText;

    if (signatureOnly && this.#lastResponseKind === "function_call") {
      if (!this.#seenSignatures.has(signature)) {
        this.#attachDetachedSignatureToLastFunctionCall(signature);
        this.#seenSignatures.add(signature);
      }

      return;
    }

    if (hasSemanticText) {
      if (targetKind !== "thought") targetKind = "text";

      if (signature !== "") {
        this.#pending = this.#pending.filter((pending) => {
          let unboundPrefix = pending.targetKind === "";

          if (pending.targetKind === targetKind) {
            unboundPrefix =
              (targetKind === "text" && this.#visibleText.length === 0) ||
              (targetKind === "thought" && this.#thoughtText.length === 0);
          }

          if (unboundPrefix) {
            if (pending.signature === signature) this.#seenSignatures.delete(signature);

            return false;
          }

          return true;
        });

        if (
          this.#pending.some(
            (pending) => pending.targetKind === targetKind && pending.signature !== signature,
          )
        ) {
          this.#flushPending(targetKind);
        }
      }

      if (
        this.#lastResponseKind !== "" &&
        this.#lastResponseKind !== targetKind &&
        (this.#lastResponseKind === "text" || this.#lastResponseKind === "thought")
      ) {
        this.#flushPending(this.#lastResponseKind);
      }

      if (targetKind === "thought") {
        if (this.#thoughtText.length === 0) this.#thoughtPartIndex = partIndex;
        this.#thoughtText += asString(text);
      } else {
        if (this.#visibleText.length === 0) this.#visiblePartIndex = partIndex;
        this.#visibleText += asString(text);
      }

      this.#lastResponseKind = targetKind;
    }

    let acceptedSignature = false;

    if (signature !== "" && !this.#seenSignatures.has(signature)) {
      if (targetKind === "") targetKind = this.#lastResponseKind;

      const unmatchedDetachedCarrier =
        signatureOnly &&
        this.#lastResponseKind === targetKind &&
        ((targetKind === "text" && this.#visibleText.length === 0) ||
          (targetKind === "thought" && this.#thoughtText.length === 0));

      if (unmatchedDetachedCarrier) {
        this.#seenSignatures.add(signature);
      } else if (
        this.#pending.length + this.#items.length + 1 > REPLAY_MAX_ITEMS_PER_ENTRY ||
        this.#itemBytes + signature.length > REPLAY_MAX_BYTES_PER_ENTRY
      ) {
        this.#overflow = true;
        this.#seenSignatures.add(signature);
      } else {
        this.#pending.push({ signature, targetKind });
        this.#seenSignatures.add(signature);
        acceptedSignature = true;
      }
    }

    if (acceptedSignature && (signatureOnly || hasSemanticText)) {
      if (targetKind === "text" && this.#visibleText.length > 0) this.#flushPending("text");
      else if (targetKind === "thought" && this.#thoughtText.length > 0)
        this.#flushPending("thought");
    }
  }

  #observeFunctionCall(functionCall: Json, partIndex: number, partSignature: string): void {
    let signature = partSignature;

    if (this.#lastResponseKind === "text" || this.#lastResponseKind === "thought") {
      this.#flushPending(this.#lastResponseKind);
    }

    if (signature !== "") {
      this.#pending = this.#pending.filter((pending) => pending.targetKind !== "");
    }

    if (signature === "") {
      for (let index = this.#pending.length - 1; index >= 0; index--) {
        const entry = this.#pending[index];

        if (entry?.targetKind === "") {
          signature = entry.signature;
          this.#pending.splice(index, 1);
          break;
        }
      }
    }

    // A thought of this turn carried the signature of the call that follows it (da21f1e5).
    if (signature === "") signature = this.#claimPrecedingTurnThoughtSignature();

    for (const key of replayToolCallKeys(functionCall)) {
      const dedupeKey =
        signature === "" ? `${key}\u0000part:${partIndex}` : `${key}\u0000${signature}`;

      if (this.#seenFunctionCalls.has(dedupeKey)) return;
      this.#seenFunctionCalls.add(dedupeKey);
    }

    const occurrenceKey = functionCallKey(
      asString(get(functionCall, "name")),
      get(functionCall, "args"),
      "",
    );

    const occurrence = this.#functionCallOccurrences.get(occurrenceKey) ?? 0;

    if (occurrenceKey !== "") this.#functionCallOccurrences.set(occurrenceKey, occurrence + 1);

    const item = buildFunctionCallPartItem(
      this.#contentIndex,
      partIndex,
      occurrence,
      functionCall,
      signature,
    );

    this.#appendItem(withContextHash(item, this.#responseContextHash));

    if (signature !== "") this.#seenSignatures.add(signature);
    this.#lastResponseKind = "function_call";
  }

  /** `claimPrecedingTurnThoughtSignature`: the latest thought signature of this turn, unless a call already has one. */
  #claimPrecedingTurnThoughtSignature(): string {
    for (const item of this.#items) {
      if (
        item["type"] === "function_call_part" &&
        asInt(item["contentIndex"]) === this.#contentIndex &&
        asString(item["thoughtSignature"]).trim() !== ""
      )
        return "";
    }

    for (let index = this.#items.length - 1; index >= 0; index--) {
      const item = this.#items[index];

      if (
        item?.["type"] !== "thought_signature" ||
        asInt(item["contentIndex"]) !== this.#contentIndex ||
        item["targetKind"] !== "thought"
      )
        continue;
      const signature = asString(item["thoughtSignature"]).trim();

      if (signature !== "") return signature;
    }

    return "";
  }

  #flushPending(targetKind: string): void {
    if (targetKind !== "text" && targetKind !== "thought") return;
    const text = targetKind === "thought" ? this.#thoughtText : this.#visibleText;
    const partIndex = targetKind === "thought" ? this.#thoughtPartIndex : this.#visiblePartIndex;
    let targetHash = "";
    let targetOccurrence = 0;

    if (text !== "") {
      targetHash = createHash("sha256").update(`${targetKind}\u0000${text}`).digest("hex");
      const occurrenceKey = `${targetKind}\u0000${targetHash}`;
      targetOccurrence = this.#segmentOccurrences.get(occurrenceKey) ?? 0;
      this.#segmentOccurrences.set(occurrenceKey, targetOccurrence + 1);
    }

    const remaining: PendingSignature[] = [];

    for (const pending of this.#pending) {
      if (pending.targetKind !== targetKind || targetHash === "") {
        remaining.push(pending);
        continue;
      }

      const item = buildThoughtSignatureItem(
        this.#contentIndex,
        partIndex,
        pending.signature,
        targetKind,
        targetHash,
      );

      item["targetOccurrence"] = targetOccurrence;
      this.#appendItem(withContextHash(item, this.#responseContextHash));
    }

    this.#pending = remaining;

    if (targetKind === "thought") {
      this.#thoughtText = "";
      this.#thoughtPartIndex = -1;
    } else {
      this.#visibleText = "";
      this.#visiblePartIndex = -1;
    }
  }

  #appendPendingSignatures(): void {
    for (const pending of this.#pending) {
      if (pending.targetKind !== "") continue;

      if (this.#lastResponseKind === "text" && this.#visibleText.length > 0)
        pending.targetKind = "text";
      else if (this.#lastResponseKind === "thought" && this.#thoughtText.length > 0)
        pending.targetKind = "thought";
      else if (this.#visibleText.length > 0) pending.targetKind = "text";
      else if (this.#thoughtText.length > 0) pending.targetKind = "thought";
    }

    this.#flushPending("thought");
    this.#flushPending("text");
    this.#pending = [];
  }

  /**
   * `Commit`: publishes the chain when the response completed; an oversized or empty chain clears the entry. A stream
   * without a finish reason contributes nothing (its tool ids stay unresolvable).
   */
  commit(ledger: ReplayLedger): Effect.Effect<void> {
    const scope = this.#scope;

    if (!replayScopeValid(scope) || !this.#terminal) return Effect.void;
    this.#committed = true;

    const clear = ledger
      .deleteIfUnchanged(scope.modelName, scope.sessionKey, scope.snapshot)
      .pipe(Effect.asVoid);

    if (this.#overflow) return clear;
    this.#appendPendingSignatures();

    if (this.#overflow || this.#items.length === 0) return clear;

    return ledger
      .replaceIfUnchanged(scope.modelName, scope.sessionKey, scope.snapshot, this.#items)
      .pipe(Effect.asVoid);
  }
}
