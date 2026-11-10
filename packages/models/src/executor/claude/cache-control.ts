/**
 * Claude `cache_control` placement, limits and TTL normalisation.
 *
 * Go source: internal/runtime/executor/claude_executor_cloaking.go (ensureCacheControl, injectToolsCacheControl,
 * injectSystemCacheControl, injectMessagesCacheControl, enforceCacheControlLimit, upgradeClaudeCacheControlTTL,
 * stripClaudeCacheControlTTL, normalizeCacheControlTTL, isExplicitPromptCacheMode, stripPromptCacheOptions,
 * shouldEnsureCacheControl, countCacheControls, isValidClaudeCacheControl, materializeTopLevelCacheControlDoc).
 * Functions mutate the parsed body in place.
 *
 * Only an object with `type: "ephemeral"` is a marker (be8c35f2); anything else is ignored and left in the body.
 * A top-level `cache_control` (automatic caching) counts like a block marker, last in evaluation order, and
 * `ensureCacheControl` moves it onto the last cacheable block (beb43359).
 */
import { get, type Json, type JsonObject } from "@commissary/json";
import { isArr, isObj, str } from "@commissary/translation";

export const CACHE_TTL_1H = "1h";

/** A text block with an optional ephemeral marker (`buildTextBlock`). */
export const textBlock = (text: string, cacheControl?: JsonObject): JsonObject =>
  cacheControl === undefined
    ? { type: "text", text }
    : { type: "text", text, cache_control: cacheControl };

const ephemeral = (): JsonObject => ({ type: "ephemeral" });

/** `isValidClaudeCacheControl`: an object with `type: "ephemeral"`. */
export const isValidCacheControl = (value: Json | undefined): value is JsonObject =>
  isObj(value) && value.type === "ephemeral";

const hasCacheControl = (value: Json | undefined): boolean =>
  isObj(value) && isValidCacheControl(value.cache_control);

/** `isExplicitPromptCacheMode`: `prompt_cache_options.mode == "explicit"` in any payload. */
export const isExplicitPromptCacheMode = (...payloads: ReadonlyArray<Json | undefined>): boolean =>
  payloads.some(
    (payload) => str(get(payload, "prompt_cache_options.mode")).trim().toLowerCase() === "explicit",
  );

export const stripPromptCacheOptions = (body: JsonObject): JsonObject => {
  delete body.prompt_cache_options;

  return body;
};

/**
 * Every block that may carry `cache_control`, in evaluation order: tools, system, message content, then the body
 * itself for a top-level marker.
 */
const cacheBlocks = (body: JsonObject): JsonObject[] => {
  const blocks: JsonObject[] = [];

  const push = (items: Json | undefined): void => {
    if (isArr(items)) for (const item of items) if (isObj(item)) blocks.push(item);
  };

  push(body.tools);
  push(body.system);

  if (isArr(body.messages))
    for (const message of body.messages) if (isObj(message)) push(message.content);

  blocks.push(body);

  return blocks;
};

export const countCacheControls = (body: JsonObject): number =>
  cacheBlocks(body).filter(hasCacheControl).length;

/** `shouldEnsureCacheControl`. */
export const shouldEnsureCacheControl = (
  body: JsonObject,
  cloaked: boolean,
  confirmedClaudeCode: boolean,
  ...candidates: ReadonlyArray<Json | undefined>
): boolean => {
  if (isExplicitPromptCacheMode(body, ...candidates)) return false;

  return !confirmedClaudeCode && (cloaked || countCacheControls(body) === 0);
};

/** `upgradeClaudeCacheControlTTL`: markers without `ttl` get `ttl`. */
export const upgradeCacheControlTTL = (body: JsonObject, ttl: string): JsonObject => {
  if (ttl === "") return body;

  for (const block of cacheBlocks(body)) {
    const cc = block.cache_control;

    if (!isObj(cc) || Object.hasOwn(cc, "ttl") || typeof cc.type !== "string") continue;
    const upgraded: JsonObject = { type: cc.type, ttl };

    const scope = cc.scope;

    if (Object.hasOwn(cc, "scope") && scope !== undefined) upgraded.scope = scope;
    block.cache_control = upgraded;
  }

  return body;
};

export const stripCacheControlTTL = (body: JsonObject): JsonObject => {
  for (const block of cacheBlocks(body)) {
    const cc = block.cache_control;

    if (isObj(cc)) delete cc.ttl;
  }

  return body;
};

/** `normalizeCacheControlTTL`: a 1h marker must not follow a 5m marker. */
export const normalizeCacheControlTTL = (body: JsonObject): JsonObject => {
  let seen5m = false;

  for (const block of cacheBlocks(body)) {
    const cc = block.cache_control;

    if (!isValidCacheControl(cc)) continue;

    if (cc.ttl !== CACHE_TTL_1H) {
      seen5m = true;
      continue;
    }

    if (seen5m) delete cc.ttl;
  }

  return body;
};

/** `ClaudePayloadHas1hTTL`. */
export const payloadHas1hTTL = (body: JsonObject): boolean =>
  cacheBlocks(body).some(
    (block) => isObj(block.cache_control) && block.cache_control.ttl === CACHE_TTL_1H,
  );

/** `enforceCacheControlLimit`: keeps at most `maxBlocks` markers (3 when the body has a `thread`). */
export const enforceCacheControlLimit = (body: JsonObject, maxBlocks: number): JsonObject => {
  let max = maxBlocks;

  if (body.thread !== undefined && body.thread !== null && max > 0) max--;
  let excess = countCacheControls(body) - max;

  if (excess <= 0) return body;

  const strip = (block: JsonObject): boolean => {
    if (excess <= 0) return false;

    if (!hasCacheControl(block)) return true;
    delete block.cache_control;
    excess--;

    return true;
  };

  const stripEarlier = (items: Json | undefined): void => {
    if (!isArr(items)) return;
    let last = -1;
    items.forEach((item, index) => {
      if (hasCacheControl(item)) last = index;
    });

    if (last < 0) return;
    items.forEach((item, index) => {
      if (index !== last && isObj(item)) strip(item);
    });
  };

  stripEarlier(body.system);

  if (excess <= 0) return body;
  stripEarlier(body.tools);

  if (excess <= 0) return body;

  if (isArr(body.messages)) {
    for (const message of body.messages) {
      const content = get(message, "content");

      if (!isArr(content)) continue;

      for (const item of content) if (isObj(item) && !strip(item)) break;

      if (excess <= 0) break;
    }
  }

  if (excess <= 0) return body;

  if (isArr(body.system)) for (const item of body.system) if (isObj(item) && !strip(item)) break;

  if (excess <= 0) return body;

  if (isArr(body.tools)) for (const item of body.tools) if (isObj(item) && !strip(item)) break;

  // The top-level marker (automatic caching) goes last.
  if (excess > 0 && isValidCacheControl(body.cache_control)) delete body.cache_control;

  return body;
};

const isBlankText = (block: Json | undefined): boolean =>
  isObj(block) && str(block.type) === "text" && str(block.text).trim() === "";

/**
 * Anthropic rejects `cache_control` on an empty text block and on thinking blocks (df07b1e5). Unlike the translators'
 * copy, a block without a `type` cannot host it either (Go `claudeContentBlockCanHostCacheControl`).
 */
const contentBlockCanHostCacheControl = (block: Json | undefined): boolean => {
  if (!isObj(block)) return false;

  switch (str(block.type)) {
    case "":
    case "thinking":
    case "redacted_thinking":
      return false;
    case "text":
      return str(block.text).trim() !== "";
    default:
      return true;
  }
};

/**
 * The index of the block of a message that takes the rolling breakpoint: the last non-empty one. An assistant turn
 * ending in a thinking block has none, because that block cannot host the marker.
 */
const lastCacheableMessageBlockIndex = (message: Json | undefined): number => {
  const content = get(message, "content");

  if (!isArr(content)) return -1;
  const assistant = str(get(message, "role")) === "assistant";

  for (let index = content.length - 1; index >= 0; index--) {
    const block = content[index];

    if (isBlankText(block)) continue;
    const type = str(get(block, "type"));

    if (assistant && (type === "thinking" || type === "redacted_thinking")) return -1;

    if (contentBlockCanHostCacheControl(block)) return index;
  }

  return -1;
};

const messageEligibleForRollingCache = (message: Json): boolean => {
  const content = get(message, "content");

  if (typeof content === "string") return content.trim() !== "";

  return lastCacheableMessageBlockIndex(message) >= 0;
};

/** Where the rolling message breakpoint goes. */
type RollingTarget =
  | { readonly kind: "final-system"; readonly message: JsonObject; readonly text: string }
  | { readonly kind: "string"; readonly message: JsonObject; readonly text: string }
  | {
      readonly kind: "block";
      readonly message: JsonObject;
      readonly content: ReadonlyArray<Json>;
      readonly index: number;
    };

const rollingMessageTarget = (body: JsonObject): RollingTarget | undefined => {
  const messages = body.messages;

  if (!isArr(messages)) return undefined;
  let lastEligible = -1;
  messages.forEach((message, index) => {
    const role = str(get(message, "role"));

    if ((role === "user" || role === "assistant") && messageEligibleForRollingCache(message))
      lastEligible = index;
  });

  if (lastEligible < 0) return undefined;
  const final = messages[messages.length - 1];
  const finalContent = get(final, "content");

  if (
    isObj(final) &&
    str(get(final, "role")) === "system" &&
    typeof finalContent === "string" &&
    finalContent.trim() !== ""
  )
    return { kind: "final-system", message: final, text: finalContent };

  const target = messages[lastEligible];

  if (!isObj(target)) return undefined;
  const content = target.content;

  if (isArr(content))
    return {
      kind: "block",
      message: target,
      content,
      index: lastCacheableMessageBlockIndex(target),
    };

  if (typeof content === "string" && content.trim() !== "")
    return { kind: "string", message: target, text: content };

  return undefined;
};

const injectMessagesCacheControl = (body: JsonObject): void => {
  const target = rollingMessageTarget(body);

  if (target === undefined) return;

  switch (target.kind) {
    case "final-system":
    case "string":
      target.message.content = [textBlock(target.text, ephemeral())];

      return;
    case "block": {
      if (target.content.some(hasCacheControl)) return;
      const last = target.content[target.index];

      if (isObj(last)) last.cache_control = ephemeral();
    }
  }
};

const injectToolsCacheControl = (body: JsonObject): void => {
  const tools = body.tools;

  if (!isArr(tools)) return;
  let lastEligible = -1;

  for (const [index, tool] of tools.entries()) {
    if (hasCacheControl(tool)) return;

    if (get(tool, "defer_loading") !== true) lastEligible = index;
  }

  const lastTool = tools[lastEligible];

  if (lastEligible >= 0 && isObj(lastTool)) lastTool.cache_control = ephemeral();
};

const systemBlockCanHostCacheControl = (item: Json | undefined): boolean => {
  if (!isObj(item)) return false;
  const type = str(item.type);

  return (type === "" || type === "text") && str(item.text).trim() !== "";
};

const lastCacheableSystemIndex = (system: ReadonlyArray<Json>): number =>
  system.findLastIndex(systemBlockCanHostCacheControl);

const injectSystemCacheControl = (body: JsonObject): void => {
  const system = body.system;

  if (isArr(system)) {
    if (system.some(hasCacheControl)) return;
    const last = system[lastCacheableSystemIndex(system)];

    if (isObj(last)) last.cache_control = ephemeral();
  } else if (typeof system === "string" && system.trim() !== "") {
    body.system = [textBlock(system, ephemeral())];
  }
};

const hasCacheableSystem = (body: JsonObject): boolean => {
  const system = body.system;

  if (isArr(system)) return lastCacheableSystemIndex(system) >= 0;

  return typeof system === "string" && system.trim() !== "";
};

const isBareEphemeral = (cacheControl: JsonObject): boolean =>
  Object.keys(cacheControl).length === 1;

/** `applyTopLevelCacheControlToBlockDoc`: the block keeps a valid marker of its own unless the top-level one is richer. */
const moveTopLevelOnto = (body: JsonObject, block: JsonObject, top: JsonObject): void => {
  const existing = block.cache_control;

  if (!isValidCacheControl(existing) || (isBareEphemeral(existing) && !isBareEphemeral(top)))
    block.cache_control = { ...top };
  delete body.cache_control;
};

/**
 * `materializeTopLevelCacheControlDoc`: moves a valid top-level `cache_control` onto the last cacheable message block,
 * else the system prompt, else the last non-deferred tool, and removes the field. It stays when nothing can host it.
 * Returns whether it landed in the messages (so the rolling breakpoint is not duplicated).
 */
const materializeTopLevelCacheControl = (body: JsonObject): boolean => {
  const top = body.cache_control;

  if (!isValidCacheControl(top)) return false;
  const target = rollingMessageTarget(body);

  if (target !== undefined) {
    if (target.kind === "block") {
      const block = target.content[target.index];

      if (isObj(block)) {
        moveTopLevelOnto(body, block, top);

        return true;
      }
    } else {
      target.message.content = [textBlock(target.text, { ...top })];
      delete body.cache_control;

      return true;
    }
  }

  const system = body.system;

  if (isArr(system)) {
    const block = system[lastCacheableSystemIndex(system)];

    if (isObj(block)) {
      moveTopLevelOnto(body, block, top);

      return false;
    }
  } else if (typeof system === "string" && system.trim() !== "") {
    body.system = [textBlock(system, { ...top })];
    delete body.cache_control;

    return false;
  }

  const tools = body.tools;

  if (isArr(tools)) {
    const index = tools.findLastIndex((tool) => get(tool, "defer_loading") !== true);
    const tool = tools[index];

    if (isObj(tool)) moveTopLevelOnto(body, tool, top);
  }

  return false;
};

/**
 * `ensureCacheControl`: the top-level marker moves onto a block, then tools (only without cacheable system), system
 * and the rolling last message (unless the top-level marker landed there).
 */
export const ensureCacheControl = (body: JsonObject): JsonObject => {
  const inMessages = materializeTopLevelCacheControl(body);

  if (!hasCacheableSystem(body)) injectToolsCacheControl(body);
  injectSystemCacheControl(body);

  if (!inMessages) injectMessagesCacheControl(body);

  return body;
};
