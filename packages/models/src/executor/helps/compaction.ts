/**
 * Responses compaction capsules shared by the Claude and Antigravity executors.
 *
 * Go source: internal/runtime/executor/helps/antigravity_compaction.go (capsule format, summary prompt, response and
 * stream builders) and internal/runtime/executor/claude_executor_compaction.go (Claude request/usage helpers).
 *
 * A capsule is `cpa-ag-compact-v1:` + base64url(no padding)(`nonce(12) || AES-256-GCM(key = SHA-256("CLIProxyAPI"),
 * plaintext = {"summary","model","created_at"})`), produced and opened with WebCrypto. The key is the fixed Go secret
 * on purpose: capsules must stay interchangeable with the Go server and between Workers deployments.
 */
import { sseEvent } from "@commissary/translation/sse";
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
} from "@commissary/json";
import { parseOpenAIUsage } from "../../usage/record.ts";

export const COMPACTION_CAPSULE_PREFIX = "cpa-ag-compact-v1:";

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

const inputItems = (payload: Json | undefined): ReadonlyArray<Json> => {
  const input = get(payload, "input");

  return isJsonArray(input) ? input : [];
};

/** `HasResponsesCompactionTrigger`: `input` contains a `compaction_trigger` item. */
export const hasResponsesCompactionTrigger = (payload: Json | undefined): boolean =>
  inputItems(payload).some((item) => asString(get(item, "type")) === "compaction_trigger");

/** `HasResponsesCompactionItem`: `input` contains a `compaction` item. */
export const hasResponsesCompactionItem = (payload: Json | undefined): boolean =>
  inputItems(payload).some((item) => asString(get(item, "type")) === "compaction");

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
export const unsealCompaction = async (encryptedContent: string): Promise<string> => {
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

/**
 * `ExpandAntigravityCompactionCapsules`: `compaction` items become developer messages carrying the summary. Returns
 * the payload unchanged (same object) when nothing was expanded; a new object otherwise. Rejects with
 * `invalid compaction capsule: ...` when a capsule cannot be opened.
 */
export const expandCompactionCapsules = async (payload: Json): Promise<Json> => {
  const input = get(payload, "input");

  if (!isJsonArray(input)) return payload;
  let changed = false;
  const expanded: Json[] = [];

  for (const item of input) {
    if (asString(get(item, "type")) !== "compaction") {
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
          if (asString(get(part, "type")) !== "output_text") continue;
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

const usageNode = (inputTokens: number, outputTokens: number, totalTokens: number): JsonObject => ({
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
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
  usage: usageNode(inputTokens, outputTokens, totalTokens),
});

/** `BuildAntigravityCompactionStreamChunks`: five SSE frames. */
export const buildCompactionStreamChunks = (
  modelName: string,
  capsule: string,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  nowMs: number,
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
    usage: usageNode(inputTokens, outputTokens, totalTokens),
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
}

/** Usage of a Responses-format summary answer (`usage.input_tokens` ...), falling back to `ParseOpenAIUsage`. */
export const responsesSummaryUsage = (payload: Json, rawText: string): ResponsesSummaryUsage => {
  const input = asInt(get(payload, "usage.input_tokens"));
  const output = asInt(get(payload, "usage.output_tokens"));
  const total = asInt(get(payload, "usage.total_tokens"));

  if (total === 0 && input === 0) {
    const usage = parseOpenAIUsage(rawText);

    return { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens };
  }

  return { input, output, total };
};
