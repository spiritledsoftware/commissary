/**
 * Devin response frames -> Interactions events / aggregate.
 *
 * Go source: internal/runtime/executor/devin_executor.go (`streamDevinFrames` event assembly,
 * `consumeDevinFramesToInteractions`, `maxDevinToolCalls`, `emitInteractionsEvent`). The assemblers are pure state
 * machines: feed decoded frames, collect the Interactions event JSON documents to translate to the client format.
 * Rules kept from Go: text after tool calls is buffered until the tools close (Responses clients need tools first);
 * thought steps stay open until text or tools arrive so late signatures can still target them; a failure before any
 * content is suppressed (the caller turns it into an HTTP error); the stream must end with the EOS trailer.
 */
import { randomUUID } from "node:crypto";
import { asString, type JsonObject, parseJsonOrText } from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import {
  applyDimensionUsage,
  type DevinFrame,
  type DevinToolCallDelta,
  type DevinUsage,
  devinTotalInputTokens,
  mergeDevinUsage,
} from "./wire.ts";

export const MAX_DEVIN_TOOL_CALLS = 128;

/** `interaction_<first 12 characters of a UUID>` (the hyphen included, like Go). */
export const newInteractionId = (): string => `interaction_${randomUUID().slice(0, 12)}`;

type Event = JsonObject;

interface ToolSlot {
  readonly stepIndex: number;
  id: string;
  name: string;
}

/** Streaming TextDecoder per text kind: multi-byte characters split across frames are re-joined (`UTF8SplitBuffer`). */
class Utf8Stream {
  readonly #decoder = new TextDecoder();
  feed(bytes: Uint8Array): string {
    return this.#decoder.decode(bytes, { stream: true });
  }
}

interface StopCompletion {
  readonly status: string;
  readonly finishReason: string;
}

const COMPLETION_BY_STOP_REASON = new Map<number, StopCompletion>([
  [1, { status: "incomplete", finishReason: "length" }],
  [3, { status: "incomplete", finishReason: "length" }],
  [11, { status: "incomplete", finishReason: "content_filter" }],
]);

const usageObject = (usage: DevinUsage | undefined): Event => {
  const out: Event = { total_input_tokens: 0, total_output_tokens: 0, total_cached_tokens: 0 };

  if (usage === undefined) return out;
  const totalInput = devinTotalInputTokens(usage);
  out["total_input_tokens"] = totalInput;
  out["total_output_tokens"] = usage.completionTokens;
  out["total_cached_tokens"] = usage.cachedTokens;

  if (usage.cacheWriteTokens > 0) out["cache_write_tokens"] = usage.cacheWriteTokens;
  out["total_tokens"] = totalInput + usage.completionTokens;

  return out;
};

const foldUsage = (current: DevinUsage | undefined, frame: DevinFrame): DevinUsage | undefined => {
  let usage = frame.usage === undefined ? current : mergeDevinUsage(current, frame.usage);
  usage = applyDimensionUsage(usage, frame.dimensionGroups);

  return usage;
};

export class DevinStreamAssembler {
  readonly interactionId: string;
  #out: string[] = [];
  #stepIndex = 0;
  #thoughtStarted = false;
  #thoughtStepIndex = -1;
  #contentStarted = false;
  #createdSent = false;
  #toolCallCount = 0;
  readonly #slots = new Map<number, ToolSlot>();
  readonly #slotById = new Map<string, ToolSlot>();
  #activeSlot: ToolSlot | undefined;
  readonly #thinking = new Utf8Stream();
  readonly #content = new Utf8Stream();
  #usage: DevinUsage | undefined;
  #lastStopReason = 0;
  #pending: Array<() => void> = [];
  #deferredThoughtStops: number[] = [];
  readonly #responseSignatures = new Map<number, string>();
  #postToolContent: string[] = [];
  #sawEos = false;

  constructor(
    readonly model: string,
    readonly responseFormat: string,
    interactionId: string = newInteractionId(),
  ) {
    this.interactionId = interactionId;
  }

  /** Text may stream independently of queued thoughts/tools only for OpenAI formats. */
  get #streamContentEarly(): boolean {
    return this.responseFormat === Formats.OpenAI || this.responseFormat === Formats.OpenAIResponse;
  }

  get usage(): DevinUsage | undefined {
    return this.#usage;
  }

  get sawEos(): boolean {
    return this.#sawEos;
  }

  /** Whether any event was emitted (used to decide if a failure still reaches the client as a stream failure). */
  get createdSent(): boolean {
    return this.#createdSent;
  }

  #emit(event: Event): void {
    const type = asString(event["event_type"]);
    const failed = type === "response.failed" || type === "interaction.failed";

    // A failure before any stream content is suppressed so the caller can return a proper HTTP status.
    if (failed && !this.#createdSent) return;

    if (!this.#createdSent && type !== "interaction.created") {
      this.#createdSent = true;
      this.#out.push(
        JSON.stringify({
          event_type: "interaction.created",
          interaction: { id: this.interactionId, model: this.model },
        }),
      );
    }

    if (type === "interaction.created") this.#createdSent = true;
    this.#out.push(JSON.stringify(event));
  }

  #stepStop(index: number): void {
    this.#emit({ event_type: "step.stop", index });
  }

  #flushPending(): void {
    if (this.#thoughtStarted) {
      this.#stepStop(this.#thoughtStepIndex);
      this.#thoughtStarted = false;
      this.#stepIndex++;
    }

    const actions = this.#pending;
    this.#pending = [];

    for (const action of actions) action();
  }

  #emitContentChunk(chunk: string): void {
    if (this.#thoughtStarted) {
      const stopIndex = this.#thoughtStepIndex < 0 ? this.#stepIndex : this.#thoughtStepIndex;

      if (this.responseFormat === Formats.OpenAIResponse) {
        // Responses items may overlap: keep reasoning open for late signatures.
        this.#deferredThoughtStops.push(stopIndex);
      } else {
        this.#stepStop(stopIndex);
      }

      this.#thoughtStarted = false;
      this.#stepIndex++;
    }

    if (this.#toolCallCount > 0) {
      this.#postToolContent.push(chunk);

      return;
    }

    if (!this.#contentStarted) {
      this.#emit({
        event_type: "step.start",
        index: this.#stepIndex,
        step: { type: "model_output" },
      });
      this.#contentStarted = true;
    }

    this.#emit({
      event_type: "step.delta",
      index: this.#stepIndex,
      delta: { type: "text", text: chunk },
    });
  }

  #emitToolCall(call: DevinToolCallDelta): void {
    if (this.#thoughtStarted) {
      this.#stepStop(this.#stepIndex);
      this.#thoughtStarted = false;
      this.#stepIndex++;
    }

    if (this.#contentStarted) {
      this.#stepStop(this.#stepIndex);
      this.#contentStarted = false;
      this.#stepIndex++;
    }

    const argsChunk = call.arguments !== "" ? call.arguments : call.invalidJsonStr;
    let slot: ToolSlot | undefined;

    if (call.id !== "") slot = this.#slotById.get(call.id);
    else slot = this.#activeSlot;

    const startEvent = (target: ToolSlot): Event => ({
      event_type: "step.start",
      index: target.stepIndex,
      step: {
        type: "function_call",
        name: target.name,
        id: target.id,
        call_id: target.id,
        arguments: {},
      },
    });

    if (slot === undefined) {
      if (this.#toolCallCount >= MAX_DEVIN_TOOL_CALLS) return;
      this.#toolCallCount++;
      const index = this.#stepIndex++;
      slot = { stepIndex: index, id: call.id, name: call.name };
      this.#slots.set(index, slot);

      if (call.id !== "") this.#slotById.set(call.id, slot);
      this.#activeSlot = slot;
      this.#emit(startEvent(slot));
    } else {
      this.#activeSlot = slot;
      let updated = false;

      if (slot.id === "" && call.id !== "") {
        slot.id = call.id;
        this.#slotById.set(call.id, slot);
        updated = true;
      }

      if (slot.name === "" && call.name !== "") {
        slot.name = call.name;
        updated = true;
      }

      if (updated) this.#emit(startEvent(slot));
    }

    if (argsChunk !== "") {
      const delta: Event = { type: "arguments_delta", arguments: argsChunk };

      if (call.arguments === "" && call.invalidJsonStr !== "") delta["invalid_json_str"] = true;
      this.#emit({ event_type: "step.delta", index: slot.stepIndex, delta });
    }
  }

  /** Feeds one decoded frame; returns the Interactions events it produced. */
  push(frame: DevinFrame): string[] {
    if (frame.stopReason !== 0) this.#lastStopReason = frame.stopReason;
    this.#usage = foldUsage(this.#usage, frame);

    if (frame.thinking.length > 0) {
      if (this.#pending.length > 0) this.#flushPending();
      const chunk = this.#thinking.feed(frame.thinking);

      if (chunk !== "") {
        if (this.#contentStarted) {
          this.#stepStop(this.#stepIndex);
          this.#contentStarted = false;
          this.#stepIndex++;
        }

        if (!this.#thoughtStarted) {
          this.#thoughtStepIndex = this.#stepIndex;
          this.#emit({
            event_type: "step.start",
            index: this.#stepIndex,
            step: { type: "thought" },
          });
          this.#thoughtStarted = true;
        }

        this.#emit({
          event_type: "step.delta",
          index: this.#thoughtStepIndex,
          delta: { type: "thought_summary", text: chunk, content: { type: "text", text: chunk } },
        });
      }
    }

    if (frame.deltaSignature.length > 0) {
      if (this.#thoughtStepIndex === -1 && !this.#contentStarted) {
        this.#thoughtStepIndex = this.#stepIndex;
        this.#emit({ event_type: "step.start", index: this.#stepIndex, step: { type: "thought" } });
        this.#thoughtStarted = true;
      }

      const target = this.#thoughtStepIndex < 0 ? 0 : this.#thoughtStepIndex;
      let signature = new TextDecoder().decode(frame.deltaSignature);

      if (this.responseFormat === Formats.OpenAIResponse) {
        // The Responses translator accepts complete signatures, not fragments.
        signature = (this.#responseSignatures.get(target) ?? "") + signature;
        this.#responseSignatures.set(target, signature);
      }

      const delta: Event = { type: "thought_signature", signature };

      if (frame.deltaSignatureType !== "") delta["signature_type"] = frame.deltaSignatureType;
      this.#emit({ event_type: "step.delta", index: target, delta });
    }

    for (const call of frame.toolCalls) {
      if (this.#thoughtStarted) this.#pending.push(() => this.#emitToolCall(call));
      else this.#emitToolCall(call);
    }

    if (frame.content.length > 0) {
      const chunk = this.#content.feed(frame.content);

      if (chunk !== "") {
        if (this.#thoughtStarted && (!this.#streamContentEarly || this.#pending.length > 0)) {
          this.#pending.push(() => this.#emitContentChunk(chunk));
        } else {
          this.#emitContentChunk(chunk);
        }
      }
    }

    return this.#drain();
  }

  /** `closeOpenSteps`. */
  #closeOpenSteps(): void {
    for (const index of this.#deferredThoughtStops) this.#stepStop(index);
    this.#deferredThoughtStops = [];

    if (this.#pending.length > 0 || this.#thoughtStarted) this.#flushPending();

    if (this.#slots.size > 0) {
      for (const index of [...this.#slots.values()]
        .map((slot) => slot.stepIndex)
        .toSorted((a, b) => a - b)) {
        this.#stepStop(index);
      }

      this.#slots.clear();
      this.#slotById.clear();
      this.#activeSlot = undefined;
    }

    if (this.#postToolContent.length > 0) {
      this.#emit({
        event_type: "step.start",
        index: this.#stepIndex,
        step: { type: "model_output" },
      });
      this.#contentStarted = true;

      for (const chunk of this.#postToolContent) {
        this.#emit({
          event_type: "step.delta",
          index: this.#stepIndex,
          delta: { type: "text", text: chunk },
        });
      }

      this.#postToolContent = [];
    }

    if (this.#contentStarted) {
      this.#stepStop(this.#stepIndex);
      this.#contentStarted = false;
    }
  }

  #drain(): string[] {
    const events = this.#out;
    this.#out = [];

    return events;
  }

  /** The EOS trailer carried an error: close the steps and fail. */
  fail(status: number, message: string): string[] {
    this.#closeOpenSteps();
    this.#emit({ event_type: "response.failed", error: { message, code: String(status) } });

    return this.#drain();
  }

  /** The body could not be read to the end (`stream_read_error`) or ended without EOS (`stream_truncated`). */
  abort(code: "stream_read_error" | "stream_truncated", message: string): string[] {
    this.#closeOpenSteps();
    this.#emit({ event_type: "response.failed", error: { message, code } });

    return this.#drain();
  }

  /** Clean end after the EOS trailer: closes the steps and emits `interaction.completed`. */
  complete(): string[] {
    this.#sawEos = true;
    this.#closeOpenSteps();
    const completion = COMPLETION_BY_STOP_REASON.get(this.#lastStopReason);

    const interaction: Event = {
      id: this.interactionId,
      model: this.model,
      status: completion?.status ?? "completed",
    };

    if (completion !== undefined) interaction["finish_reason"] = completion.finishReason;
    interaction["usage"] = usageObject(this.#usage);
    this.#emit({ event_type: "interaction.completed", interaction });

    return this.#drain();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Non-stream aggregation
// ---------------------------------------------------------------------------------------------------------------

interface ToolBuilder {
  id: string;
  name: string;
  args: string;
  legacy: boolean;
}

export interface DevinAggregate {
  /** The Interactions response document. */
  readonly interaction: JsonObject;
  readonly usage: DevinUsage | undefined;
  /** Tool calls whose arguments arrived as invalid JSON (`legacy`), by name (apply_patch detection). */
  readonly legacyToolNames: ReadonlyArray<string>;
}

const concat = (parts: ReadonlyArray<Uint8Array>): string => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return new TextDecoder().decode(out);
};

/** `consumeDevinFramesToInteractions` over already decoded frames (the caller validated the trailer). */
export class DevinAggregator {
  #thinking: Uint8Array[] = [];
  #signature: Uint8Array[] = [];
  #preText: Uint8Array[] = [];
  #postText: Uint8Array[] = [];
  #tools: ToolBuilder[] = [];
  readonly #toolIndexById = new Map<string, number>();
  #lastTool = -1;
  #usage: DevinUsage | undefined;
  #lastStopReason = 0;
  readonly unknownFields = new Set<number>();

  get usage(): DevinUsage | undefined {
    return this.#usage;
  }

  push(frame: DevinFrame): void {
    if (frame.stopReason !== 0) this.#lastStopReason = frame.stopReason;

    for (const field of frame.unknownFields) this.unknownFields.add(field);
    this.#usage = foldUsage(this.#usage, frame);

    if (frame.deltaSignature.length > 0) this.#signature.push(frame.deltaSignature);

    if (frame.thinking.length > 0) this.#thinking.push(frame.thinking);

    for (const call of frame.toolCalls) {
      const chunk = call.arguments !== "" ? call.arguments : call.invalidJsonStr;
      let index = -1;

      if (call.id !== "") index = this.#toolIndexById.get(call.id) ?? -1;
      else if (this.#lastTool >= 0) index = this.#lastTool;
      let builder: ToolBuilder;

      if (index < 0) {
        if (this.#tools.length >= MAX_DEVIN_TOOL_CALLS) continue;
        index = this.#tools.length;
        builder = { id: call.id, name: call.name, args: "", legacy: false };
        this.#tools.push(builder);

        if (call.id !== "") this.#toolIndexById.set(call.id, index);
      } else {
        const existing = this.#tools[index];

        if (existing === undefined) continue;
        builder = existing;

        if (builder.id === "" && call.id !== "") {
          builder.id = call.id;
          this.#toolIndexById.set(call.id, index);
        }

        if (call.name !== "") builder.name = call.name;
      }

      this.#lastTool = index;

      if (call.arguments === "" && call.invalidJsonStr !== "") builder.legacy = true;

      if (chunk !== "") builder.args += chunk;
    }

    if (frame.content.length > 0)
      (this.#tools.length > 0 ? this.#postText : this.#preText).push(frame.content);
  }

  finish(model: string, interactionId: string = newInteractionId()): DevinAggregate {
    const completion = COMPLETION_BY_STOP_REASON.get(this.#lastStopReason);

    const out: JsonObject = {
      id: interactionId,
      model,
      status: completion?.status ?? "completed",
    };

    if (completion !== undefined) out["finish_reason"] = completion.finishReason;
    const steps: JsonObject[] = [];
    const signature = this.#signature.length > 0 ? concat(this.#signature) : "";

    if (this.#thinking.length > 0 || this.#signature.length > 0) {
      const thought: JsonObject = { type: "thought" };

      if (this.#thinking.length > 0)
        thought["content"] = [{ type: "text", text: concat(this.#thinking) }];

      if (this.#signature.length > 0) {
        thought["signature"] = signature;
        thought["thought_signature"] = signature;
      }

      steps.push(thought);
    }

    if (this.#preText.length > 0) {
      steps.push({
        type: "model_output",
        content: [{ type: "text", text: concat(this.#preText) }],
      });
    }

    const legacyToolNames: string[] = [];

    for (const tool of this.#tools) {
      if (tool.id === "" && tool.name === "" && tool.args === "") continue;

      if (tool.legacy) legacyToolNames.push(tool.name);

      const step: JsonObject = {
        type: "function_call",
        name: tool.name,
        id: tool.id,
        call_id: tool.id,
        arguments: {},
      };

      if (tool.args !== "") {
        step["arguments"] = parseJsonOrText(tool.args);
      }

      steps.push(step);
    }

    if (this.#postText.length > 0) {
      steps.push({
        type: "model_output",
        content: [{ type: "text", text: concat(this.#postText) }],
      });
    }

    out["steps"] = steps;
    out["usage"] = usageObject(this.#usage);

    return { interaction: out, usage: this.#usage, legacyToolNames };
  }
}
