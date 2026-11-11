/**
 * Responses compaction shared by every executor that compacts locally (Claude, Antigravity, Codex `is-compat`,
 * OpenAI-compatible, Kimi, Meta, Devin) and by Codex's capsule expansion.
 *
 * Go source: internal/runtime/executor/helps/antigravity_compaction.go (capsule format, summary prompt, response and
 * stream builders, expansion, status check) and internal/runtime/executor/claude_executor_compaction.go (Claude
 * request/usage helpers); the local flow is the shared form of codex_executor_execute.go (`executeCodexResponsesCompaction`),
 * openai_compat_executor.go, kimi_executor.go, meta_executor_execute.go and devin_executor_compaction.go.
 *
 * A capsule is `cpa-ag-compact-v1:` + base64url(no padding)(`nonce(12) || AES-256-GCM(key = SHA-256("CLIProxyAPI"),
 * plaintext = {"summary","model","created_at"})`), produced and opened with WebCrypto. The key is the fixed Go secret
 * on purpose: capsules must stay interchangeable with the Go server and between Workers deployments.
 */
import { Effect, Stream } from "effect";
import { sseEvent } from "@commissary/translation/sse";
import { Formats } from "@commissary/translation/formats";
import { parseSuffix } from "@commissary/translation/thinking";
import {
  asInt,
  asString,
  cloneJson,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { parseOpenAIUsage } from "../../usage/record.ts";
import { ExecutionError } from "../errors.ts";
import type { ExecutorOptions, ExecutorRequest, ExecutorResponse, StreamResult } from "../types.ts";
import { previousResponseNotFoundError } from "../websocket/session.ts";

export const COMPACTION_CAPSULE_PREFIX = "cpa-ag-compact-v1:";

const COMPACTION_ITEM_ID_PREFIX = "cmp_ag_compact_";

const COMPACTION_RESPONSE_ID_PREFIX = "resp_ag_compact_";

const KEY_SECRET = "CLIProxyAPI";

const NONCE_BYTES = 12;

const GCM_TAG_BYTES = 16;

const SUMMARY_PROMPT_TEXT =
  "Please provide a concise and comprehensive summary of the preceding conversation and task progress so far, including user goals, key findings, actions taken, and current status, so that work can continue smoothly.";

const summaryPrompt = (): JsonObject => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: SUMMARY_PROMPT_TEXT }],
});

/** `RecognizedAntigravityCompactionCapsule`. */
export const recognizedCompactionCapsule = (encryptedContent: string): boolean =>
  encryptedContent.trim().startsWith(COMPACTION_CAPSULE_PREFIX);

/** `RecognizedResponsesCompactionResponseID`: the id of a response a local compaction minted. */
export const recognizedCompactionResponseId = (responseId: string): boolean =>
  responseId.trim().startsWith(COMPACTION_RESPONSE_ID_PREFIX);

/** `isRecognizedCPACompactionItem`: a `compaction` item minted by a local compaction (capsule prefix or item id). */
export const recognizedCompactionItem = (item: Json): boolean =>
  asString(get(item, "type")) === "compaction" &&
  (recognizedCompactionCapsule(asString(get(item, "encrypted_content"))) ||
    asString(get(item, "id")).trim().startsWith(COMPACTION_ITEM_ID_PREFIX));

const inputItems = (payload: Json | undefined): ReadonlyArray<Json> => {
  const input = get(payload, "input");

  return isJsonArray(input) ? input : [];
};

/** `HasResponsesCompactionTrigger`: `input` contains a `compaction_trigger` item. */
export const hasResponsesCompactionTrigger = (payload: Json | undefined): boolean =>
  inputItems(payload).some((item) => asString(get(item, "type")) === "compaction_trigger");

/** Input items that steer the client, not the conversation: a summary request never carries them (d576416a, d57270f4). */
const CONTROL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "compaction_trigger",
  "additional_tools",
  "configuration_update",
]);

const isControlItem = (item: Json): boolean =>
  CONTROL_ITEM_TYPES.has(asString(get(item, "type")).trim());

/**
 * `PrepareAntigravityCompactionSummaryPayload`: control items (`compaction_trigger`, `additional_tools`,
 * `configuration_update`) dropped, the summary request appended, fields that do not apply to a one-shot summary removed
 * (`text.format` would replace the summary with structured output), `stream: false`. Returns a new object.
 */
export const prepareCompactionSummaryPayload = (payload: Json): Json => {
  const out = cloneJson(payload);
  const input = get(out, "input");

  if (isJsonArray(input)) {
    set(out, "input", [...input.filter((item) => !isControlItem(item)), summaryPrompt()]);
  } else if (typeof input === "string" && input !== "") {
    set(out, "input", [
      { type: "message", role: "user", content: [{ type: "input_text", text: input }] },
      summaryPrompt(),
    ]);
  } else {
    set(out, "input", [summaryPrompt()]);
  }

  for (const field of [
    "type",
    "event_id",
    "text",
    "stream",
    "tools",
    "tool_choice",
    "previous_response_id",
    "parallel_tool_calls",
    "additional_tools",
    "truncation",
    "metadata",
  ]) {
    del(out, field);
  }

  set(out, "stream", false);

  return out;
};

// ---------------------------------------------------------------------------------------------------------------------
// Capsule encryption
// ---------------------------------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

let keyPromise: Promise<CryptoKey> | undefined;

/** `deriveAntigravityCompactionKey`: SHA-256 of the fixed secret as an AES-GCM key (derived once per isolate). */
const capsuleKey = (): Promise<CryptoKey> => {
  keyPromise ??= crypto.subtle
    .digest("SHA-256", encoder.encode(KEY_SECRET))
    .then((digest) =>
      crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    );

  return keyPromise;
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/** Go `base64.RawURLEncoding.DecodeString` (no padding, URL alphabet; trailing bits are ignored). */
const fromBase64Url = (text: string): Uint8Array => {
  const bad = text.search(/[^A-Za-z0-9_-]/);

  if (bad >= 0) throw new Error(`illegal base64 data at input byte ${bad}`);

  if (text.length % 4 === 1) throw new Error(`illegal base64 data at input byte ${text.length}`);
  const standard = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/** The capsule plaintext (`antigravityCompactionCapsuleData`). Capsules sealed with Go's HTML-escaped text still open. */
export const capsulePlaintext = (summary: string, model: string, createdAt: number): string =>
  JSON.stringify({ summary, model, created_at: createdAt });

/**
 * `SealAntigravityCompaction`. `nonce` and `createdAtSec` are injectable for tests; production uses a random nonce
 * and the current time.
 */
export const sealCompaction = async (
  summary: string,
  modelName: string,
  options: { readonly createdAtSec?: number; readonly nonce?: Uint8Array } = {},
): Promise<string> => {
  const createdAt = options.createdAtSec ?? Math.floor(Date.now() / 1000);
  const nonce = options.nonce ?? crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      await capsuleKey(),
      encoder.encode(capsulePlaintext(summary, modelName, createdAt)),
    ),
  );

  const sealed = new Uint8Array(nonce.length + encrypted.length);
  sealed.set(nonce);
  sealed.set(encrypted, nonce.length);

  return COMPACTION_CAPSULE_PREFIX + toBase64Url(sealed);
};

/** `UnsealAntigravityCompaction`: the summary text, or an `Error` carrying the Go message. */
export const unsealCompaction = async (sealedContent: string): Promise<string> => {
  const encryptedContent = sealedContent.trim();

  if (!encryptedContent.startsWith(COMPACTION_CAPSULE_PREFIX))
    throw new Error("unrecognized compaction capsule format");
  let ciphertext: Uint8Array;

  try {
    ciphertext = fromBase64Url(encryptedContent.slice(COMPACTION_CAPSULE_PREFIX.length));
  } catch (error) {
    throw new Error(
      `decode compaction capsule: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }

  if (ciphertext.length < NONCE_BYTES + GCM_TAG_BYTES)
    throw new Error("compaction capsule ciphertext too short");
  let plaintext: ArrayBuffer;

  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ciphertext.subarray(0, NONCE_BYTES) },
      await capsuleKey(),
      ciphertext.subarray(NONCE_BYTES),
    );
  } catch (error) {
    throw new Error(
      "invalid or corrupted compaction capsule: cipher: message authentication failed",
      { cause: error },
    );
  }

  let data: unknown;

  try {
    data = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    throw new Error(
      `unmarshal compaction capsule: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }

  return isJsonObject(data) ? asString(data["summary"]) : "";
};

/** Expands the `compaction` items `selected` accepts into developer messages; the other items stay as they are. */
const expandSelectedCapsules = async (
  payload: Json,
  selected: (item: Json) => boolean,
): Promise<Json> => {
  const input = get(payload, "input");

  if (!isJsonArray(input)) return payload;
  let changed = false;
  const expanded: Json[] = [];

  for (const item of input) {
    if (asString(get(item, "type")) !== "compaction" || !selected(item)) {
      expanded.push(item);
      continue;
    }

    let summary: string;

    try {
      summary = await unsealCompaction(asString(get(item, "encrypted_content")));
    } catch (error) {
      throw new Error(
        `invalid compaction capsule: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    }

    expanded.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: `Context summary from previous turns:\n${summary}` }],
    });
    changed = true;
  }

  if (!changed) return payload;
  const out = cloneJson(payload);
  set(out, "input", expanded);

  return out;
};

/**
 * `ExpandAntigravityCompactionCapsules`: `compaction` items become developer messages carrying the summary. Returns
 * the payload unchanged (same object) when nothing was expanded; a new object otherwise. Rejects with
 * `invalid compaction capsule: ...` when a capsule cannot be opened.
 */
export const expandCompactionCapsules = (payload: Json): Promise<Json> =>
  expandSelectedCapsules(payload, () => true);

/**
 * `DropForeignResponsesCompactionItems`: `compaction` items no local compaction minted cannot be read by another
 * provider and are dropped (Go logs a warning). Returns the payload itself when nothing was dropped.
 */
const dropForeignCompactionItems = (payload: Json): Json => {
  const input = get(payload, "input");

  if (!isJsonArray(input)) return payload;

  const kept = input.filter(
    (item) => asString(get(item, "type")) !== "compaction" || recognizedCompactionItem(item),
  );

  if (kept.length === input.length) return payload;
  const out = cloneJson(payload);
  set(out, "input", kept);

  return out;
};

type ExpandedRequest = {
  readonly request: ExecutorRequest;
  readonly options: ExecutorOptions;
};

/** `payload` and `originalRequest` through `transform`; when they are one object they stay one object. */
const transformRequestPair = async (
  request: ExecutorRequest,
  options: ExecutorOptions,
  transform: (payload: Json) => Promise<Json>,
): Promise<ExpandedRequest> => {
  const payload = await transform(request.payload);
  const { originalRequest } = options;

  const original =
    originalRequest === undefined
      ? undefined
      : originalRequest === request.payload
        ? payload
        : await transform(originalRequest);

  return {
    request: payload === request.payload ? request : { ...request, payload },
    options: original === originalRequest ? options : { ...options, originalRequest: original },
  };
};

/**
 * The capsule expansion of an executor entry point (`ExpandResponsesCompactionCapsules`,
 * `ExpandRecognizedResponsesCompactionCapsules`): the capsules of the request and of the original request become
 * developer context before translation and token counting, and an unreadable one is a request-scoped 400
 * (`invalid compaction capsule: ...`). `drop-foreign` is for a route that cannot read a foreign `compaction` item, which it
 * drops; `recognized-only` for one that forwards native items (Codex, a `/responses/compact` endpoint) and expands only
 * the capsules a local compaction minted.
 */
export const expandCompaction = (
  request: ExecutorRequest,
  options: ExecutorOptions,
  mode: "drop-foreign" | "recognized-only",
): Effect.Effect<ExpandedRequest, ExecutionError> =>
  Effect.tryPromise({
    try: () =>
      transformRequestPair(request, options, (payload) =>
        mode === "drop-foreign"
          ? expandCompactionCapsules(dropForeignCompactionItems(payload))
          : expandSelectedCapsules(payload, recognizedCompactionItem),
      ),
    // An unreadable capsule is the client's fault: a request-scoped 400 (no cooldown, no failover).
    catch: (error) =>
      new ExecutionError({
        status: 400,
        message: error instanceof Error ? error.message : String(error),
        requestScoped: true,
      }),
  });

/** `ExtractAntigravitySummaryText`: Responses, Gemini/Antigravity, Claude or Chat Completions response bodies. */
export const extractSummaryText = (response: Json): string => {
  const output = get(response, "output");

  if (isJsonArray(output)) {
    const parts: string[] = [];

    for (const item of output) {
      if (asString(get(item, "type")) !== "message") continue;
      const content = get(item, "content");

      if (isJsonArray(content)) {
        for (const part of content) {
          const partType = asString(get(part, "type"));

          if (partType !== "output_text" && partType !== "text") continue;
          const text = asString(get(part, "text"));

          if (text !== "") parts.push(text);
        }
      } else if (typeof content === "string" && content !== "") {
        parts.push(content);
      }
    }

    if (parts.length > 0) return parts.join("\n");
  }

  const candidates = get(response, "response.candidates") ?? get(response, "candidates");

  if (isJsonArray(candidates) && candidates.length > 0) {
    const parts: string[] = [];
    const content = get(candidates[0], "content.parts");

    if (isJsonArray(content)) {
      for (const part of content) {
        if (get(part, "thought") === true) continue;
        const text = asString(get(part, "text"));

        if (text !== "") parts.push(text);
      }
    }

    if (parts.length > 0) return parts.join("\n");
  }

  const blocks = get(response, "content");

  if (isJsonArray(blocks)) {
    const parts: string[] = [];

    for (const block of blocks) {
      if (asString(get(block, "type")) !== "text") continue;
      const text = asString(get(block, "text"));

      if (text !== "") parts.push(text);
    }

    if (parts.length > 0) return parts.join("\n");
  }

  const chat = asString(get(response, "choices.0.message.content"));

  if (chat !== "") return chat;
  throw new Error("no summary text found in upstream response");
};

// ---------------------------------------------------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------------------------------------------------

/** The token counts a summary reports beyond input, output and total. */
export interface CompactionUsageDetails {
  readonly cached?: number;
  readonly reasoning?: number;
}

const usageNode = (
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  details: CompactionUsageDetails = {},
): JsonObject => ({
  input_tokens_details: { cached_tokens: details.cached ?? 0 },
  output_tokens_details: { reasoning_tokens: details.reasoning ?? 0 },
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  total_tokens: totalTokens,
});

/** Go `time.Now().UnixNano()` for an injected millisecond clock. */
const unixNano = (nowMs: number): string => `${nowMs}000000`;

/** `BuildAntigravityCompactionResponse`. */
export const buildCompactionResponse = (
  modelName: string,
  capsule: string,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  nowMs: number,
  details: CompactionUsageDetails = {},
): JsonObject => ({
  object: "response.compaction",
  status: "completed",
  id: `resp_ag_compact_${unixNano(nowMs)}`,
  created_at: Math.floor(nowMs / 1000),
  model: modelName,
  output: [
    {
      type: "compaction",
      status: "completed",
      id: `cmp_ag_compact_${unixNano(nowMs)}`,
      encrypted_content: capsule,
    },
  ],
  usage: usageNode(inputTokens, outputTokens, totalTokens, details),
});

/** `BuildAntigravityCompactionStreamChunks`: five SSE frames. */
export const buildCompactionStreamChunks = (
  modelName: string,
  capsule: string,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  nowMs: number,
  details: CompactionUsageDetails = {},
): string[] => {
  const now = Math.floor(nowMs / 1000);
  const responseId = `resp_ag_compact_${unixNano(nowMs)}`;
  const itemId = `cmp_ag_compact_${unixNano(nowMs)}`;

  const item = (status: string): JsonObject => ({
    type: "compaction",
    status,
    id: itemId,
    encrypted_content: capsule,
  });

  const created = (): JsonObject => ({
    object: "response",
    status: "in_progress",
    background: false,
    error: null,
    output: [],
    id: responseId,
    created_at: now,
    model: modelName,
  });

  const completed: JsonObject = {
    object: "response",
    status: "completed",
    background: false,
    error: null,
    id: responseId,
    created_at: now,
    completed_at: now,
    model: modelName,
    output: [item("completed")],
    usage: usageNode(inputTokens, outputTokens, totalTokens, details),
  };

  const frame = (name: string, payload: JsonObject): string =>
    sseEvent(name, JSON.stringify(payload));

  return [
    frame("response.created", {
      type: "response.created",
      sequence_number: 0,
      response: created(),
    }),
    frame("response.in_progress", {
      type: "response.in_progress",
      sequence_number: 1,
      response: created(),
    }),
    frame("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: item("in_progress"),
    }),
    frame("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 0,
      item: item("completed"),
    }),
    frame("response.completed", {
      type: "response.completed",
      sequence_number: 4,
      response: completed,
    }),
  ];
};

export interface ResponsesSummaryUsage {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly cached: number;
  readonly reasoning: number;
}

/**
 * `ExtractResponsesCompactionUsage`: usage of a Responses-format summary answer (`usage.input_tokens` ...), falling back
 * to `ParseOpenAIUsage`.
 */
export const responsesSummaryUsage = (payload: Json, rawText: string): ResponsesSummaryUsage => {
  const input = asInt(get(payload, "usage.input_tokens"));
  const output = asInt(get(payload, "usage.output_tokens"));
  const total = asInt(get(payload, "usage.total_tokens"));

  if (total === 0 && input === 0 && output === 0) {
    const usage = parseOpenAIUsage(rawText);

    return {
      input: usage.inputTokens,
      output: usage.outputTokens,
      total: usage.totalTokens,
      cached: usage.cachedTokens,
      reasoning: usage.reasoningTokens,
    };
  }

  return {
    input,
    output,
    total,
    cached: asInt(get(payload, "usage.input_tokens_details.cached_tokens")),
    reasoning: asInt(get(payload, "usage.output_tokens_details.reasoning_tokens")),
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Local compaction: the summary request, its checks and the synthetic answer
// ---------------------------------------------------------------------------------------------------------------------

/** `HasResponsesCompactionTriggerRequest`: the payload or the original request carries a `compaction_trigger` item. */
export const hasResponsesCompactionTriggerRequest = (
  request: ExecutorRequest,
  options: ExecutorOptions,
): boolean =>
  hasResponsesCompactionTrigger(request.payload) ||
  hasResponsesCompactionTrigger(options.originalRequest);

/** `ResponsesCompactionSourcePayload`: the payload that carries the trigger or the request history. */
export const compactionSourcePayload = (
  request: ExecutorRequest,
  options: ExecutorOptions,
): Json => {
  let payload: Json = request.payload;
  const original = options.originalRequest;

  if (
    original !== undefined &&
    !hasResponsesCompactionTrigger(payload) &&
    hasResponsesCompactionTrigger(original)
  ) {
    payload = original;
  }

  if ((payload === undefined || payload === null) && original !== undefined) payload = original;

  return payload;
};

/** `HasResponsesCompactionConversationInput`: `input` carries at least one item that is not a control item. */
export const hasCompactionConversationInput = (payload: Json | undefined): boolean => {
  const input = get(payload, "input");

  if (typeof input === "string") return input.trim() !== "";

  if (!isJsonArray(input)) return false;

  return input.some((item) => !isControlItem(item));
};

/**
 * The request-scoped 502 of a summary that cannot be sealed: incomplete, failed or without text. Another credential
 * would usually fail the same way at the same cost, so there is no cooldown and no failover (a difference from Go,
 * which answers a plain 502 or, on Claude and Antigravity, a 500).
 */
export const compactionSummaryError = (message: string): ExecutionError =>
  new ExecutionError({ status: 502, message, requestScoped: true });

/**
 * `validateCodexLocalCompactionSource` for every local route: the history a `previous_response_id` or a
 * `response.append` refers to is not in the request, so a capsule sealed from it would silently lose it. An empty
 * conversation has nothing to summarise. Over a downstream WebSocket the answer is the non-closing 409
 * `previous_response_not_found` frame; over HTTP a request-scoped 400.
 */
export const checkCompactionSource = (
  source: Json,
  options: ExecutorOptions,
): ExecutionError | undefined => {
  const previous = asString(get(source, "previous_response_id")).trim();
  const requestType = asString(get(source, "type")).trim();

  if (previous !== "" || requestType === "response.append") {
    return options.metadata.websocket !== undefined
      ? previousResponseNotFoundError()
      : new ExecutionError({
          status: 400,
          message:
            "local summary compaction requires full conversation input without previous_response_id",
          requestScoped: true,
        });
  }

  if (!hasCompactionConversationInput(source)) {
    return new ExecutionError({
      status: 400,
      message: "local summary compaction requires non-empty conversation input",
      requestScoped: true,
    });
  }

  return undefined;
};

/**
 * `rejectSyntheticCompactionPreviousResponseID`: a `previous_response_id` that names a response a local compaction
 * minted refers to nothing upstream. Over a downstream WebSocket the answer is the 409 frame, over HTTP a 400.
 */
export const rejectSyntheticPreviousResponseId = (
  payload: Json,
  options: ExecutorOptions,
): ExecutionError | undefined => {
  if (!recognizedCompactionResponseId(asString(get(payload, "previous_response_id"))))
    return undefined;

  return options.metadata.websocket !== undefined
    ? previousResponseNotFoundError()
    : new ExecutionError({
        status: 400,
        message:
          "previous_response_id references a local compaction response; resend full conversation input without previous_response_id",
        requestScoped: true,
      });
};

/**
 * `ValidateResponsesCompactionSummaryStatus`: the failure message of a summary that did not finish with status
 * `completed`, `undefined` when it did. A Claude message (`type: "message"`) has no `status`: it counts as completed
 * unless its `stop_reason` is `max_tokens`, which is an incomplete summary.
 */
export const compactionSummaryStatusError = (summary: Json | undefined): string | undefined => {
  let status = asString(get(summary, "status")).trim().toLowerCase();

  if (status === "") status = asString(get(summary, "response.status")).trim().toLowerCase();
  const stopReason = asString(get(summary, "stop_reason"));

  if (stopReason === "max_tokens") status = "incomplete";
  else if (status === "" && asString(get(summary, "type")) === "message") status = "completed";

  if (status !== "completed")
    return `compaction summary response status is "${status === "" ? "missing" : status}", want "completed"`;
  const eventType = asString(get(summary, "type")).trim().toLowerCase();

  if (eventType === "response.incomplete" || eventType === "response.failed")
    return `compaction summary response terminal event is "${eventType}"`;

  for (const path of [
    "incomplete_details",
    "response.incomplete_details",
    "error",
    "response.error",
  ]) {
    const node = get(summary, path);

    if (node !== undefined && node !== null) return `compaction summary response contains ${path}`;
  }

  const output = get(summary, "output");

  if (isJsonArray(output)) {
    for (const item of output) {
      const itemStatus = asString(get(item, "status")).trim().toLowerCase();

      if (itemStatus !== "" && itemStatus !== "completed")
        return `compaction summary output item status is "${itemStatus}", want "completed"`;
    }
  }

  return undefined;
};

/**
 * `BuildResponsesCompactionResponseFromSummary`: a Responses-format summary sealed into a `response.compaction` body.
 * Fails with the request-scoped 502 when the summary is incomplete or has no text.
 */
export const sealCompactionSummary = (
  modelName: string,
  summaryBody: string,
  nowMs: number,
): Effect.Effect<JsonObject, ExecutionError> =>
  Effect.gen(function* () {
    const summary = tryParseJson(summaryBody);
    const statusError = compactionSummaryStatusError(summary);

    if (statusError !== undefined) return yield* compactionSummaryError(statusError);

    const text = yield* Effect.try({
      try: () => extractSummaryText(summary ?? null),
      catch: (error) =>
        compactionSummaryError(
          `extract summary: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    const capsule = yield* Effect.tryPromise({
      try: () => sealCompaction(text, modelName),
      catch: (error) =>
        new ExecutionError({ status: 500, message: `seal compaction capsule: ${String(error)}` }),
    });

    const usage = responsesSummaryUsage(summary ?? null, summaryBody);

    return buildCompactionResponse(
      modelName,
      capsule,
      usage.input,
      usage.output,
      usage.total,
      nowMs,
      {
        cached: usage.cached,
        reasoning: usage.reasoning,
      },
    );
  });

/**
 * `BuildResponsesCompactionStreamChunksFromResponse`: the sealed `response.compaction` answer as the synthetic Responses
 * stream a streaming client expects.
 */
export const compactionStreamFromResponse = (
  modelName: string,
  response: ExecutorResponse,
  nowMs: number,
): Effect.Effect<StreamResult, ExecutionError> =>
  Effect.gen(function* () {
    const parsed = tryParseJson(response.payload);
    const capsule = asString(get(parsed, "output.0.encrypted_content"));

    if (asString(get(parsed, "output.0.type")) !== "compaction" || capsule === "")
      return yield* compactionSummaryError("extract summary: compaction item missing");

    const chunks = buildCompactionStreamChunks(
      modelName,
      capsule,
      asInt(get(parsed, "usage.input_tokens")),
      asInt(get(parsed, "usage.output_tokens")),
      asInt(get(parsed, "usage.total_tokens")),
      nowMs,
      {
        cached: asInt(get(parsed, "usage.input_tokens_details.cached_tokens")),
        reasoning: asInt(get(parsed, "usage.output_tokens_details.reasoning_tokens")),
      },
    );

    const headers = new Headers(response.headers);
    headers.set("Content-Type", "text/event-stream");

    return { headers, chunks: Stream.fromIterable(chunks) } satisfies StreamResult;
  });

/** What a route hands the shared local compaction. */
export interface LocalCompactionInput<R> {
  /** The request after {@link expandCompaction}. */
  readonly request: ExecutorRequest;
  readonly options: ExecutorOptions;
  /**
   * The route's own non-stream Responses turn (not its public `execute`: the summary must not meet the compaction
   * check again, and Codex's WebSocket dispatch). It publishes the usage of the attempt.
   */
  readonly summaryTurn: (
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) => Effect.Effect<ExecutorResponse, ExecutionError, R>;
}

/**
 * `MarkLocalWebsocketTurn`: reports on a downstream WebSocket that the request is answered without the upstream socket
 * (every local compaction, Claude's and Antigravity's own flows included), so the handler keeps the socket in HTTP mode
 * and records the boundary transcript.
 */
export const markLocalCompaction = (options: ExecutorOptions): void => {
  const report = options.metadata.websocket?.report;

  if (report !== undefined) report.local = true;
};

/**
 * Local compaction (`executeCodexResponsesCompaction`, `executeOpenAICompatResponsesCompaction`, ...): the request's own
 * model summarises the history and the summary is sealed into a capsule. The answer is the `response.compaction` body;
 * {@link compactionStreamFromResponse} turns it into a stream.
 *
 * It reports on a downstream WebSocket that the request ran without the upstream socket. Nothing reaches the client
 * before the summary is sealed, so a failed attempt can fail over to the next credential and run it all again.
 */
export const executeLocalCompaction = <R>(
  input: LocalCompactionInput<R>,
): Effect.Effect<ExecutorResponse, ExecutionError, R> =>
  Effect.gen(function* () {
    const { request, options } = input;
    markLocalCompaction(options);
    const source = compactionSourcePayload(request, options);
    const sourceError = checkCompactionSource(source, options);

    if (sourceError !== undefined) return yield* sourceError;
    const baseModel = parseSuffix(request.model).modelName;

    const summaryRequest: ExecutorRequest = {
      ...request,
      payload: prepareCompactionSummaryPayload(source),
    };

    const summaryOptions: ExecutorOptions = {
      ...options,
      alt: "",
      stream: false,
      originalRequest: undefined,
      sourceFormat: Formats.OpenAIResponse,
      responseFormat: Formats.OpenAIResponse,
    };

    const summary = yield* input.summaryTurn(summaryRequest, summaryOptions);
    const body = yield* sealCompactionSummary(baseModel, summary.payload, Date.now());

    return { payload: JSON.stringify(body), headers: summary.headers } satisfies ExecutorResponse;
  });

/**
 * `BuildResponsesCompactionStreamChunksFromResponse` for a route's sealed answer: the `response.compaction` body as the
 * synthetic Responses stream of a streaming client.
 */
export const localCompactionStream = (
  request: ExecutorRequest,
  sealed: ExecutorResponse,
): Effect.Effect<StreamResult, ExecutionError> =>
  compactionStreamFromResponse(parseSuffix(request.model).modelName, sealed, Date.now());

/** What a route that compacts on both entry points hands the dispatch. */
export interface LocalCompactionRoute<R> extends LocalCompactionInput<R> {
  /** The route's ordinary non-stream turn, for every request that is not a compaction. */
  readonly turn: (
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) => Effect.Effect<ExecutorResponse, ExecutionError, R>;
  /** The route's ordinary streaming turn. */
  readonly streamTurn: (
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) => Effect.Effect<StreamResult, ExecutionError, R>;
}

/**
 * `execute` of Kimi, Meta and Devin: a Responses request has its capsules expanded and its foreign `compaction` items
 * dropped, and a `compaction_trigger` or `/responses/compact` is compacted locally (Go answers 501 to the latter on
 * Kimi and Meta); anything else is the route's own turn.
 */
export const dispatchLocalCompaction = <R>(
  route: LocalCompactionRoute<R>,
): Effect.Effect<ExecutorResponse, ExecutionError, R> =>
  Effect.gen(function* () {
    if (route.options.sourceFormat !== Formats.OpenAIResponse)
      return yield* route.turn(route.request, route.options);

    const { request, options } = yield* expandCompaction(
      route.request,
      route.options,
      "drop-foreign",
    );

    if (
      options.alt === "responses/compact" ||
      hasResponsesCompactionTriggerRequest(request, options)
    )
      return yield* executeLocalCompaction({ ...route, request, options });

    return yield* route.turn(request, options);
  });

/**
 * `executeStream` of Kimi, Meta and Devin: like {@link dispatchLocalCompaction}; a streaming `/responses/compact` stays the
 * 400 it is everywhere, and a `compaction_trigger` answers with the synthetic stream.
 */
export const dispatchLocalCompactionStream = <R>(
  route: LocalCompactionRoute<R>,
): Effect.Effect<StreamResult, ExecutionError, R> =>
  Effect.gen(function* () {
    if (route.options.sourceFormat !== Formats.OpenAIResponse)
      return yield* route.streamTurn(route.request, route.options);

    if (route.options.alt === "responses/compact") {
      return yield* new ExecutionError({
        status: 400,
        message: "streaming not supported for /responses/compact",
        requestScoped: true,
      });
    }

    const { request, options } = yield* expandCompaction(
      route.request,
      route.options,
      "drop-foreign",
    );

    if (hasResponsesCompactionTriggerRequest(request, options)) {
      const sealed = yield* executeLocalCompaction({ ...route, request, options });

      return yield* localCompactionStream(request, sealed);
    }

    return yield* route.streamTurn(request, options);
  });
