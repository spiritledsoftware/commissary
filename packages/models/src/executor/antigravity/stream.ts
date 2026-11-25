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

/** `StreamScannerBuffer`: the largest JSON payload the assembler buffers. */
const MAX_ASSEMBLED_BYTES = 52_428_800;

/** `isSSEControlLine`: an SSE comment or a field other than `data`. */
const isControlLine = (trimmed: string): boolean =>
  trimmed.startsWith(":") ||
  trimmed.startsWith("event:") ||
  trimmed.startsWith("id:") ||
  trimmed.startsWith("retry:") ||
  trimmed === "event" ||
  trimmed === "id" ||
  trimmed === "retry";

/**
 * `SSEJSONAssembler` (CLIProxyAPI 892fc486): reassembles JSON payloads that upstream split over several SSE lines. A
 * malformed event is isolated to its own event: only an empty line ends an event, and a `data:` payload that outgrows
 * the limit is dropped up to that line. Lengths are counted in UTF-16 units, close enough for a 50 MiB bound.
 */
export class JsonAssembler {
  #pending = "";
  #fromData = false;
  #discardUntilBlank = false;

  #reset(): void {
    this.#pending = "";
    this.#fromData = false;
    this.#discardUntilBlank = false;
  }

  /** The next complete JSON payload, or `undefined` when the line carries none (yet). */
  push(line: string): string | undefined {
    if (line.replace(/\r$/, "") === "") {
      this.#reset();

      return undefined;
    }

    if (this.#discardUntilBlank) return undefined;
    const trimmed = line.trim();

    if (trimmed === "") return undefined;

    if (this.#pending !== "") {
      if (isControlLine(trimmed)) return undefined;
      let chunk: string;

      if (trimmed.startsWith("data:")) chunk = trimmed.slice(5).trim();
      else if (trimmed === "data" || this.#fromData) return undefined;
      else chunk = trimmed;

      if (chunk === "[DONE]") {
        this.#reset();

        return undefined;
      }

      if (chunk === "") return undefined;

      if (this.#pending.length + 1 + chunk.length > MAX_ASSEMBLED_BYTES) {
        const wasFromData = this.#fromData;
        this.#reset();
        this.#discardUntilBlank = wasFromData;

        return undefined;
      }

      this.#pending += `\n${chunk}`;

      if (tryParseJson(this.#pending) === undefined) return undefined;
      const payload = this.#pending;
      this.#reset();

      return payload;
    }

    const payload = jsonPayload(line);

    if (payload === undefined) return undefined;

    if (tryParseJson(payload) !== undefined) return payload;
    const fromData = trimmed.startsWith("data:");

    if (payload.length > MAX_ASSEMBLED_BYTES) {
      this.#discardUntilBlank = fromData;

      return undefined;
    }

    this.#pending = payload;
    this.#fromData = fromData;

    return undefined;
  }
}

/**
 * The status of an in-band `error` object in an HTTP 2xx body or stream frame (`antigravityInBandErrorStatusCode`):
 * its `code` when that is a 4xx/5xx, else 502; `undefined` without one (a `null` error is none).
 */
export const inBandErrorStatus = (root: Json | undefined): number | undefined => {
  const error = get(root, "error");

  if (error === undefined || error === null) return undefined;
  const status = Math.trunc(Number(get(error, "code") ?? 0));

  return status >= 400 && status <= 599 ? status : 502;
};

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
  let groundingMetadata: Json | undefined;
  const parts: Json[] = [];
  let pendingKind = "";
  let pendingText = "";
  let pendingSignature = "";
  // The pending text started in the chunk being read: parts of one chunk stay apart (CLIProxyAPI 9176cb22).
  let pendingFromCurrentChunk = false;

  const resetPending = (): void => {
    pendingKind = "";
    pendingText = "";
    pendingSignature = "";
    pendingFromCurrentChunk = false;
  };

  /** Text and thoughts keep their signatures, and whitespace-only text stays (CLIProxyAPI 9176cb22). */
  const flushPending = (): void => {
    if (pendingKind === "") return;

    if (pendingText !== "" || pendingSignature !== "") {
      const part: JsonObject =
        pendingKind === "thought" ? { text: pendingText, thought: true } : { text: pendingText };

      if (pendingSignature !== "") part["thoughtSignature"] = pendingSignature;
      parts.push(part);
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
    // Grounding from an earlier chunk survives a terminal chunk without it (CLIProxyAPI d0da9a9a).
    const grounding = get(node, "candidates.0.groundingMetadata");

    if (isJsonObject(grounding)) groundingMetadata = structuredClone(grounding);

    const nodeParts = get(node, "candidates.0.content.parts");

    if (!isJsonArray(nodeParts)) continue;
    pendingFromCurrentChunk = false;

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
        if (text === "" && signature === "") continue;
        const kind = thought ? "thought" : "text";

        // An empty text part that only carries a signature stays a part of its own, so consecutive detached
        // signatures never overwrite each other.
        if (!thought && text === "" && signature !== "") {
          flushPending();
          parts.push({ text: "", thoughtSignature: signature });
          continue;
        }

        const isThoughtTrailingSignature =
          thought &&
          text === "" &&
          signature !== "" &&
          pendingKind === "thought" &&
          pendingSignature === "";

        if (
          pendingKind !== "" &&
          (pendingKind !== kind ||
            pendingSignature !== "" ||
            (pendingFromCurrentChunk && !isThoughtTrailingSignature))
        )
          flushPending();
        pendingKind = kind;
        pendingText += text;

        if (signature !== "") pendingSignature = signature;
        pendingFromCurrentChunk = true;
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

  if (
    groundingMetadata !== undefined &&
    get(template, "candidates.0.groundingMetadata") === undefined
  )
    set(template, "candidates.0.groundingMetadata", groundingMetadata);

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
