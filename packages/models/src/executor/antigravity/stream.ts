/**
 * Antigravity SSE handling: usage filtering, split-JSON accumulation and stream -> single response aggregation.
 *
 * Go source: internal/runtime/executor/helps/usage_helpers.go (`FilterSSEUsageMetadata`, `isStopChunkWithoutUsage`),
 * internal/runtime/executor/antigravity_executor_stream.go (pending JSON accumulation, in-stream `error` objects),
 * antigravity_executor_execute.go (`convertStreamToNonStream`).
 */
import {
  asBool,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { jsonPayload, stripUsageMetadataFromJson } from "../gemini/usage.ts";
import { ExecutionError } from "../errors.ts";
import { antigravityStatusError } from "./errors.ts";

const finishReasonOf = (root: Json | undefined): string =>
  asString(
    get(root, "candidates.0.finishReason") ?? get(root, "response.candidates.0.finishReason"),
  ).trim();

const hasUsage = (root: Json | undefined): boolean =>
  get(root, "usageMetadata") !== undefined || get(root, "response.usageMetadata") !== undefined;

/**
 * `FilterSSEUsageMetadata` with the Antigravity stop-chunk bookkeeping: usage on non-terminal chunks is renamed
 * `cpaUsageMetadata`; a finishReason chunk without usage remembers its `traceId`, and the next chunk with that
 * `traceId` that does carry usage is passed through untouched. The memory is per stream (Go keeps a 10 min process
 * map; one trace never spans streams).
 */
export class UsageFilter {
  readonly #stopWithoutUsage = new Set<string>();

  filter(line: string): string {
    if (line === "") return line;
    const trimmed = line.trim();
    const dataIndex = line.indexOf("data:");
    const isData = trimmed.startsWith("data:");
    const rawText = isData ? line.slice(dataIndex + 5).trim() : trimmed;
    const root = tryParseJson(rawText);
    const traceId = asString(get(root, "traceId"));

    if (root !== undefined) {
      if (finishReasonOf(root) !== "" && !hasUsage(root) && traceId !== "") {
        this.#stopWithoutUsage.add(traceId);

        return line;
      }

      if (traceId !== "" && this.#stopWithoutUsage.has(traceId) && hasUsage(root)) {
        this.#stopWithoutUsage.delete(traceId);

        return line;
      }
    }

    const cleaned = stripUsageMetadataFromJson(rawText);

    if (!cleaned.changed) return line;

    return isData ? `${line.slice(0, dataIndex)}data: ${cleaned.text}` : cleaned.text;
  }
}

/** Result of feeding one SSE line to {@link JsonAssembler}. */
export type Assembled =
  | { readonly kind: "none" }
  | { readonly kind: "payload"; readonly payload: string }
  | { readonly kind: "error"; readonly error: ExecutionError };

/** Collects JSON objects that upstream split over several SSE lines (`pendingJSON`) and detects `error` objects. */
export class JsonAssembler {
  #pending = "";

  push(line: string): Assembled {
    let payload = jsonPayload(line);

    if (this.#pending !== "") {
      let trimmed = line.trim();

      if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();

      if (trimmed !== "") this.#pending += `\n${trimmed}`;

      if (tryParseJson(this.#pending) === undefined) return { kind: "none" };
      payload = this.#pending;
      this.#pending = "";
    } else if (payload !== undefined && tryParseJson(payload) === undefined) {
      this.#pending = payload;

      return { kind: "none" };
    }

    if (payload === undefined) return { kind: "none" };
    const error = get(tryParseJson(payload), "error");

    if (error !== undefined) {
      let status = Math.trunc(Number(get(error, "code") ?? 0));

      if (!(status >= 400 && status <= 599)) status = 502;

      return { kind: "error", error: antigravityStatusError(status, payload, new Headers()) };
    }

    return { kind: "payload", payload };
  }
}

/** A chunk is terminal when it carries a finishReason, or when its translation ends the client stream. */
export const isTerminalPayload = (payload: string): boolean =>
  finishReasonOf(tryParseJson(payload)) !== "";

/** Whether a translated client chunk ends the stream (`[DONE]`, `response.completed`, `message_stop`, finish_reason). */
export const isTerminalClientChunk = (chunk: string): boolean => {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "data: [DONE]" || trimmed === "[DONE]") return true;
    const payload = jsonPayload(line);

    if (payload === undefined) continue;
    const root = tryParseJson(payload);
    const type = asString(get(root, "type"));

    if (type === "response.completed" || type === "message_stop") return true;

    if (asString(get(root, "choices.0.finish_reason")).trim() !== "") return true;
  }

  return false;
};

/** `convertStreamToNonStream`: merges the streamed `response` objects into one non-stream response. */
export const convertStreamToNonStream = (lines: ReadonlyArray<string>): Json => {
  let responseTemplate: JsonObject | undefined;
  let traceId = "";
  let finishReason = "";
  let modelVersion = "";
  let responseId = "";
  let role = "";
  let usage: Json | undefined;
  const parts: Json[] = [];
  let pendingKind = "";
  let pendingText = "";
  let pendingSignature = "";

  const resetPending = (): void => {
    pendingKind = "";
    pendingText = "";
    pendingSignature = "";
  };

  const flushPending = (): void => {
    if (pendingKind === "") return;

    if (pendingKind === "text") {
      if (pendingText.trim() !== "") parts.push({ text: pendingText });
    } else if (pendingText.trim() !== "" || pendingSignature !== "") {
      parts.push(
        pendingSignature !== ""
          ? { text: pendingText, thought: true, thoughtSignature: pendingSignature }
          : { text: pendingText, thought: true },
      );
    }

    resetPending();
  };

  const normalizePart = (part: Json): Json => {
    const copy = isJsonObject(part) ? structuredClone(part) : {};

    const signature =
      asString(get(part, "thoughtSignature")) || asString(get(part, "thought_signature"));

    if (signature !== "") {
      copy["thoughtSignature"] = signature;
      delete copy["thought_signature"];
    }

    if (copy["inline_data"] !== undefined) {
      copy["inlineData"] = copy["inline_data"];
      delete copy["inline_data"];
    }

    return copy;
  };

  for (const line of lines) {
    const root = tryParseJson(line.trim());

    if (root === undefined) continue;
    let node = get(root, "response");

    if (node === undefined) {
      if (get(root, "candidates") === undefined) continue;
      node = root;
    }

    if (isJsonObject(node)) responseTemplate = structuredClone(node);
    const trace = asString(get(root, "traceId"));

    if (trace !== "") traceId = trace;
    const nodeRole = get(node, "candidates.0.content.role");

    if (nodeRole !== undefined) role = asString(nodeRole);
    const finish = asString(get(node, "candidates.0.finishReason"));

    if (finish !== "") finishReason = finish;
    const model = asString(get(node, "modelVersion"));

    if (model !== "") modelVersion = model;
    const id = asString(get(node, "responseId"));

    if (id !== "") responseId = id;
    // The last `usageMetadata` wins; a renamed non-terminal one (`cpaUsageMetadata`) only fills a gap (Go `d5eb4ca1`).
    const nodeUsage = get(node, "usageMetadata");
    const renamedUsage = get(node, "cpaUsageMetadata");

    if (nodeUsage !== undefined) usage = structuredClone(nodeUsage);
    else if (renamedUsage !== undefined && usage === undefined)
      usage = structuredClone(renamedUsage);

    const rootUsage = get(root, "usageMetadata");

    if (usage === undefined && rootUsage !== undefined) usage = structuredClone(rootUsage);

    const nodeParts = get(node, "candidates.0.content.parts");

    if (!isJsonArray(nodeParts)) continue;

    for (const part of nodeParts) {
      const hasFunctionCall = get(part, "functionCall") !== undefined;

      const hasInlineData =
        get(part, "inlineData") !== undefined || get(part, "inline_data") !== undefined;

      const signature =
        asString(get(part, "thoughtSignature")) || asString(get(part, "thought_signature"));

      const text = asString(get(part, "text"));
      const thought = asBool(get(part, "thought"));

      if (hasFunctionCall || hasInlineData) {
        flushPending();
        parts.push(normalizePart(part));
        continue;
      }

      if (thought || get(part, "text") !== undefined) {
        const kind = thought ? "thought" : "text";

        if (pendingKind !== "" && pendingKind !== kind) flushPending();
        pendingKind = kind;
        pendingText += text;

        if (kind === "thought" && signature !== "") pendingSignature = signature;
        continue;
      }

      flushPending();
      parts.push(normalizePart(part));
    }
  }

  flushPending();

  const template: Json = responseTemplate ?? {
    candidates: [{ content: { role: "model", parts: [] } }],
  };

  set(template, "candidates.0.content.parts", parts);

  if (role !== "") set(template, "candidates.0.content.role", role);

  if (finishReason !== "") set(template, "candidates.0.finishReason", finishReason);

  if (modelVersion !== "") set(template, "modelVersion", modelVersion);

  if (responseId !== "") set(template, "responseId", responseId);

  if (usage !== undefined) set(template, "usageMetadata", usage);
  else if (get(template, "usageMetadata") === undefined) {
    set(template, "usageMetadata.promptTokenCount", 0);
    set(template, "usageMetadata.candidatesTokenCount", 0);
    set(template, "usageMetadata.totalTokenCount", 0);
  }

  if (isJsonObject(template)) delete template["cpaUsageMetadata"];

  const output: JsonObject = { response: template, traceId: "" };

  if (traceId !== "") output["traceId"] = traceId;

  return output;
};
