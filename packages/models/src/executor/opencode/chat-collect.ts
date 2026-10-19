/**
 * A streamed Chat Completions answer collected into one `chat.completion` document, for non-stream clients of a
 * request that must stream upstream (the OpenCode Zen free-tier cloak, ADR 0033).
 *
 * Workers addition (no OpenCode provider in Go). Content, refusal, reasoning (`reasoning_content`) and tool-call argument
 * deltas are concatenated per choice and call index; the last `usage` wins (log probabilities are not kept). An error payload in the stream fails the
 * answer the way the stream reader does (`openAICompatStreamDataError`). An upstream that answers a plain JSON
 * document despite `stream: true` is returned as it is.
 */
import { Predicate } from "effect";
import { type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { isArr, isObj } from "@commissary/translation";
import { ExecutionError } from "../errors.ts";
import { isOpenAICompatErrorEvent, openAICompatStreamDataError } from "../openai-compat/stream.ts";

interface CallParts {
  id?: string;
  type?: string;
  name?: string;
  readonly args: string[];
}

interface ChoiceParts {
  role: string;
  readonly content: string[];
  readonly refusal: string[];
  readonly reasoning: string[];
  readonly calls: Map<number, CallParts>;
  finish: Json;
}

const text = (value: Json | undefined): string | undefined =>
  Predicate.isString(value) ? value : undefined;

const indexOf = (value: Json | undefined): number => (Predicate.isNumber(value) ? value : 0);

class Collector {
  #id: Json = "";
  #created: Json = 0;
  #model: Json = "";
  #fingerprint: Json | undefined;
  #usage: Json | undefined;
  readonly #choices = new Map<number, ChoiceParts>();

  #choice(index: number): ChoiceParts {
    let parts = this.#choices.get(index);

    if (parts === undefined) {
      parts = {
        role: "assistant",
        content: [],
        refusal: [],
        reasoning: [],
        calls: new Map(),
        finish: null,
      };
      this.#choices.set(index, parts);
    }

    return parts;
  }

  #call(parts: ChoiceParts, index: number): CallParts {
    let call = parts.calls.get(index);

    if (call === undefined) {
      call = { args: [] };
      parts.calls.set(index, call);
    }

    return call;
  }

  push(chunk: JsonObject): void {
    if (chunk.id !== undefined) this.#id = chunk.id;

    if (chunk.created !== undefined) this.#created = chunk.created;

    if (chunk.model !== undefined) this.#model = chunk.model;

    if (chunk.system_fingerprint !== undefined) this.#fingerprint = chunk.system_fingerprint;

    if (isObj(chunk.usage)) this.#usage = chunk.usage;

    if (!isArr(chunk.choices)) return;

    for (const choice of chunk.choices) {
      if (!isObj(choice)) continue;
      const parts = this.#choice(indexOf(choice.index));

      if (choice.finish_reason !== undefined && choice.finish_reason !== null)
        parts.finish = choice.finish_reason;
      const delta = isObj(choice.delta) ? choice.delta : undefined;

      if (delta === undefined) continue;
      const role = text(delta.role);

      if (role !== undefined && role !== "") parts.role = role;
      const content = text(delta.content);

      if (content !== undefined) parts.content.push(content);
      const refusal = text(delta.refusal);

      if (refusal !== undefined) parts.refusal.push(refusal);
      const reasoning = text(delta.reasoning_content);

      if (reasoning !== undefined) parts.reasoning.push(reasoning);

      if (!isArr(delta.tool_calls)) continue;

      for (const raw of delta.tool_calls) {
        if (!isObj(raw)) continue;
        const call = this.#call(parts, indexOf(raw.index));
        const id = text(raw.id);

        if (id !== undefined && id !== "") call.id = id;
        const type = text(raw.type);

        if (type !== undefined && type !== "") call.type = type;
        const fn = isObj(raw.function) ? raw.function : undefined;
        const name = text(fn?.name);

        if (name !== undefined && name !== "") call.name = name;
        const args = text(fn?.arguments);

        if (args !== undefined) call.args.push(args);
      }
    }
  }

  result(): JsonObject {
    const choices = [...this.#choices.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([index, parts]) => {
        const message: JsonObject = {
          role: parts.role,
          content: parts.content.length === 0 ? null : parts.content.join(""),
        };

        if (parts.refusal.length > 0) message.refusal = parts.refusal.join("");

        if (parts.reasoning.length > 0) message.reasoning_content = parts.reasoning.join("");

        if (parts.calls.size > 0) {
          message.tool_calls = [...parts.calls.entries()]
            .toSorted(([a], [b]) => a - b)
            .map(([, call]) => ({
              id: call.id ?? "",
              type: call.type ?? "function",
              function: { name: call.name ?? "", arguments: call.args.join("") },
            }));
        }

        return { index, message, finish_reason: parts.finish };
      });

    const out: JsonObject = {
      id: this.#id,
      object: "chat.completion",
      created: this.#created,
      model: this.#model,
      choices,
    };

    if (this.#fingerprint !== undefined) out.system_fingerprint = this.#fingerprint;

    if (this.#usage !== undefined) out.usage = this.#usage;

    return out;
  }
}

const gatewayError = (message: string) => new ExecutionError({ status: 502, message });

/** The `chat.completion` JSON of an upstream SSE body; an `ExecutionError` for an error payload or a truncated frame. */
export const collectChatStream = (
  body: string,
): { readonly text: string } | { readonly error: ExecutionError } => {
  const trimmedBody = body.trim();

  if (trimmedBody.startsWith("{") && tryParseJson(trimmedBody) !== undefined)
    return { text: trimmedBody };

  const collector = new Collector();
  let event = "";
  let data: string[] = [];

  const frame = (): ExecutionError | "done" | undefined => {
    const payload = data.join("\n").trim();
    const name = event;
    event = "";
    data = [];

    if (payload === "")
      return isOpenAICompatErrorEvent(name)
        ? gatewayError("upstream error event ended without data")
        : undefined;

    if (payload === "[DONE]") return "done";
    const parsed = tryParseJson(payload);

    if (parsed === undefined)
      return gatewayError("upstream stream ended with incomplete SSE data frame");
    const error = openAICompatStreamDataError(payload, name);

    if (error !== undefined) return error;

    if (isObj(parsed)) collector.push(parsed);

    return undefined;
  };

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();

    if (line === "") {
      const step = frame();

      if (step === "done") break;

      if (step !== undefined) return { error: step };
      continue;
    }

    if (line.startsWith("data:")) data.push(line.slice(5).trim());
    else if (line.startsWith("event:")) event = line.slice(6).trim();
  }

  if (data.length > 0) {
    const step = frame();

    if (step !== undefined && step !== "done") return { error: step };
  }

  return { text: JSON.stringify(collector.result()) };
};
