/**
 * Cache-control propagation helpers.
 *
 * Go source: internal/translator/common/cache_control.go.
 */
import { cloneJson, get, type Json, type JsonObject } from "@commissary/json";
import { exists, isArr, isObj, str } from "./gjson.ts";

/** Only `{"type":"ephemeral"}` style objects are propagated. */
export const isValidCacheControl = (cc: Json | undefined): cc is JsonObject =>
  isObj(cc) && typeof cc.type === "string" && cc.type === "ephemeral";

/** Anthropic rejects `cache_control` on empty text blocks and does not accept it on thinking blocks. */
const canHostCacheControl = (block: Json | undefined): boolean => {
  if (!isObj(block)) return false;

  switch (str(block.type)) {
    case "":
      return true;
    case "thinking":
    case "redacted_thinking":
      return false;
    case "text":
      return str(block.text).trim() !== "";
    default:
      return true;
  }
};

/** `AttachCacheControl`: copies a valid `cache_control` from `src` onto `dst` (never onto an empty text block). */
export const attachCacheControl = (dst: JsonObject, src: Json | undefined): JsonObject => {
  const cc = get(src, "cache_control");

  if (!isValidCacheControl(cc) || !canHostCacheControl(dst)) return dst;
  dst.cache_control = cloneJson(cc);

  return dst;
};

/**
 * A blank text part is dropped (Anthropic answers 400 to it), but its `cache_control` is kept by moving it to the
 * block before it, when that block has none (Go `df07b1e5`). `from` is the index of the first block of the
 * message or system run the part belongs to: nothing moves when no block of that run precedes it.
 */
export const moveBlankPartCacheControl = (
  blocks: JsonObject[],
  from: number,
  part: Json | undefined,
): void => {
  if (!exists(get(part, "cache_control")) || blocks.length <= from) return;
  // SAFETY: `blocks.length > from >= 0`, so the last index is in bounds.
  const previous = blocks[blocks.length - 1] as JsonObject;

  if (previous.cache_control === undefined) attachCacheControl(previous, part);
};

/**
 * `AttachMessageCacheControl`: puts message-level `cache_control` on the last content block that can host it
 * (empty text blocks are skipped).
 */
export const attachMessageCacheControl = (msg: JsonObject, src: Json | undefined): JsonObject => {
  const cc = get(src, "cache_control");

  if (!isValidCacheControl(cc)) return msg;
  const content = msg.content;

  if (isArr(content)) {
    const target = content.findLast(canHostCacheControl);

    if (target === undefined || exists(get(target, "cache_control"))) return msg;

    if (isObj(target)) target.cache_control = cloneJson(cc);

    return msg;
  }

  if (typeof content !== "string" || content.trim() === "") return msg;
  msg.content = [{ type: "text", text: content, cache_control: cloneJson(cc) }];

  return msg;
};

const extractFirstPartCacheControl = (src: Json | undefined): JsonObject | undefined => {
  let content = get(src, "content");

  if (content === undefined) content = src;

  if (isArr(content)) {
    for (const part of content) {
      const cc = get(part, "cache_control");

      if (isValidCacheControl(cc)) return cc;
    }

    return undefined;
  }

  if (isObj(content)) {
    const cc = get(content, "cache_control");

    if (isValidCacheControl(cc)) return cc;
  }

  return undefined;
};

/** `AttachToolMessageCacheControl`: hoists part/message cache_control onto the first `tool_result` block. */
export const attachToolMessageCacheControl = (
  msg: JsonObject,
  src: Json | undefined,
): JsonObject => {
  let cc = extractFirstPartCacheControl(src);

  if (cc === undefined) {
    const own = get(src, "cache_control");

    if (isValidCacheControl(own)) cc = own;
  }

  if (cc === undefined) return msg;
  const content = msg.content;

  if (!isArr(content) || content.length === 0) return msg;
  const target = content.find((block) => str(get(block, "type")) === "tool_result");

  if (target === undefined || !isObj(target)) return msg;
  target.cache_control = cloneJson(cc);

  return msg;
};
