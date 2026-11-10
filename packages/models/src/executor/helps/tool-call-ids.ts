/**
 * Non-portable tool call ids: Anthropic accepts only `[A-Za-z0-9_-]` in `tool_use.id` and `tool_result.tool_use_id`.
 *
 * Go source: internal/runtime/executor/helps/tool_call_ids.go (isPortableToolCallID, EncodeDevinToolCallID,
 * DecodeDevinToolCallID, NormalizeClaudeToolCallIDs). A non-portable id becomes `cpa_tid_v1_` + base64url(id), a pure
 * function of the transcript, so nothing is stored and the cache prefix stays stable. The prefix is Go's (ADR 0018
 * precedent: ids that end up in client histories keep the Go format).
 */
import type { JsonObject } from "@commissary/json";
import { isArr, isObj, str } from "@commissary/translation";

const ID_PREFIX = "cpa_tid_v1_";

const PORTABLE = /^[A-Za-z0-9_-]+$/;

/** The block types of the client's calls and results, with the field holding the id. */
const ID_FIELDS: ReadonlyMap<string, string> = new Map([
  ["tool_use", "id"],
  ["tool_result", "tool_use_id"],
]);

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** `isPortableToolCallID`: non-empty and made of `[A-Za-z0-9_-]` only. */
export const isPortableToolCallId = (id: string): boolean => PORTABLE.test(id);

const toBase64Url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/**
 * `EncodeDevinToolCallID`: reserves a namespace so native ids cannot collide with encoded ones. Empty ids stay empty;
 * a portable id stays as it is unless it already carries the prefix, which is encoded once more.
 */
export const encodeToolCallId = (id: string): string =>
  id === "" || (isPortableToolCallId(id) && !id.startsWith(ID_PREFIX))
    ? id
    : ID_PREFIX + toBase64Url(id);

/**
 * `DecodeDevinToolCallID`: removes exactly one canonical encoding layer. Ordinary legal ids, malformed encodings and
 * base64-looking ids that are not the canonical encoding of what they decode to stay intact.
 */
export const decodeToolCallId = (id: string): string => {
  if (!id.startsWith(ID_PREFIX)) return id;
  const encoded = id.slice(ID_PREFIX.length);

  // A base64 length of 1 mod 4 never occurs for whole bytes.
  if (!BASE64URL.test(encoded) || encoded.length % 4 === 1) return id;

  try {
    const original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(encoded, "base64url"),
    );

    return original !== "" && encodeToolCallId(original) === id ? original : id;
  } catch {
    return id;
  }
};

/** The `tool_use`/`tool_result` blocks of the body whose id field is a non-empty string, with that field's name. */
const idBlocks = (body: JsonObject): Array<{ block: JsonObject; field: string; id: string }> => {
  const found: Array<{ block: JsonObject; field: string; id: string }> = [];

  if (!isArr(body.messages)) return found;

  for (const message of body.messages) {
    if (!isObj(message) || !isArr(message.content)) continue;

    for (const block of message.content) {
      if (!isObj(block)) continue;
      const field = ID_FIELDS.get(str(block.type));
      const id = field === undefined ? undefined : block[field];

      if (field !== undefined && typeof id === "string" && id !== "")
        found.push({ block, field, id });
    }
  }

  return found;
};

/**
 * `NormalizeClaudeToolCallIDs`: rewrites the non-portable ids of the client's tool calls and results in place. Legal
 * ids (including existing encodings) are never re-encoded. An encoding that collides with a legal id of the same
 * body gets an underscore prefix until it is unique.
 */
export const normalizeClaudeToolCallIds = (body: JsonObject): void => {
  const blocks = idBlocks(body);
  const used = new Set<string>();

  for (const { id } of blocks) if (isPortableToolCallId(id)) used.add(id);
  const mapped = new Map<string, string>();

  for (const { block, field, id } of blocks) {
    if (isPortableToolCallId(id)) continue;
    let replacement = mapped.get(id);

    if (replacement === undefined) {
      replacement = encodeToolCallId(id);

      while (used.has(replacement)) replacement = `_${replacement}`;
      mapped.set(id, replacement);
      used.add(replacement);
    }

    block[field] = replacement;
  }
};
