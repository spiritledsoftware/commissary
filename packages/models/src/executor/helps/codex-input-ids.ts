/**
 * Codex input item id normalisation.
 *
 * Go source: internal/runtime/executor/helps/codex_input_ids.go (SanitizeCodexInputItemIDs). Item ids get a type
 * prefix, encrypted reasoning items with ids over 64 characters are dropped and other overlong ids are shortened
 * deterministically (sha256 suffix) without colliding with existing ids. Characters outside `[A-Za-z0-9_-]` (base64
 * `+` and `/`, for one) become `_`, also in the prefix kept by a hash-shortened id (606e667a).
 */
import { createHash } from "node:crypto";
import { asString, get, isJsonArray, isJsonObject, type Json } from "@commissary/json";

const ID_LIMIT = 64;

const PREFIXES = new Map<string, string>(
  Object.entries({
    message: "msg",
    reasoning: "rs",
    function_call: "fc",
    custom_tool_call: "ctc",
    custom_tool_call_output: "ctco",
    tool_search_call: "tsc",
  }),
);

const OCCUPIED = 1;

const PRESERVED = 2;

// SEEN and DUPLICATE (with the per-original collision key below) arrived in Go 90c447d3 with the `tsc_` prefix of a
// `tool_search_call`: a replayed item from another provider's tool search (`ts_` legacy, or a bare id) is rewritten to it.
const SEEN = 4;

const DUPLICATE = 8;

const runeLength = (text: string): number => {
  let count = 0;

  for (const _ of text) count++;

  return count;
};

const runes = (text: string): string[] => Array.from(text);

/** `sanitizeCodexInputItemIDChars`. */
const sanitizeChars = (id: string): string => id.replace(/[^A-Za-z0-9_-]/gu, "_");

/** `normalizeCodexInputItemIDPrefix`: the type prefix only, characters untouched. */
const normalizeItemIdPrefix = (item: Json, id: string): string => {
  const type = asString(get(item, "type"));
  const prefix = PREFIXES.get(type);

  if (prefix === undefined) return id;

  if (type === "tool_search_call" && id.startsWith("ts_") && id.length > 3)
    return `${prefix}_${id.slice(3)}`;

  if (id === "" || id.startsWith(prefix)) return id;

  return `${prefix}_${id}`;
};

/** Overlong ids keep their raw characters: the hash is taken over them and the kept prefix is sanitised later. */
const normalizeItemId = (item: Json, id: string): string => {
  const normalized = normalizeItemIdPrefix(item, id);

  return runeLength(normalized) > ID_LIMIT ? normalized : sanitizeChars(normalized);
};

const shouldDropEncryptedReasoning = (item: Json): boolean => {
  if (asString(get(item, "type")) !== "reasoning") return false;
  const id = get(item, "id");

  if (typeof id !== "string" || runeLength(id) <= ID_LIMIT) return false;
  const encrypted = get(item, "encrypted_content");

  return typeof encrypted === "string" && encrypted !== "";
};

const withHashSuffix = (id: string, attempt: number): string => {
  const hashInput = attempt > 0 ? `${id}\u0000${attempt}` : id;
  const suffix = `_${createHash("sha256").update(hashInput).digest("hex").slice(0, 16)}`;
  const characters = runes(id);
  const prefixLength = Math.min(characters.length, ID_LIMIT - suffix.length);

  return sanitizeChars(characters.slice(0, prefixLength).join("")) + suffix;
};

const shorten = (id: string, attempt: number): string =>
  runeLength(id) <= ID_LIMIT ? id : withHashSuffix(id, attempt);

/** `SanitizeCodexInputItemIDs`; mutates `body.input` in place and returns the body. */
export const sanitizeCodexInputItemIds = <T extends Json>(body: T): T => {
  const input = get(body, "input");

  if (!isJsonArray(input)) return body;
  const states = new Map<string, number>();

  for (const item of input) {
    if (shouldDropEncryptedReasoning(item)) continue;
    const itemId = get(item, "id");

    if (typeof itemId !== "string") continue;
    const id = normalizeItemId(item, itemId);
    let state = states.get(id) ?? 0;

    if ((state & SEEN) !== 0) state |= DUPLICATE;
    state |= SEEN;

    if (id === itemId) state |= PRESERVED;

    if (runeLength(id) <= ID_LIMIT) state |= OCCUPIED;

    states.set(id, state);
  }

  const mapped = new Map<string, string>();
  const collisionMapped = new Map<string, string>();
  const rebuilt: Json[] = [];
  let changed = false;

  for (const item of input) {
    if (shouldDropEncryptedReasoning(item)) {
      changed = true;
      continue;
    }

    const itemId = get(item, "id");

    if (typeof itemId === "string" && isJsonObject(item)) {
      let id = normalizeItemId(item, itemId);

      if (id !== itemId && ((states.get(id) ?? 0) & (PRESERVED | DUPLICATE)) !== 0) {
        const collisionKey = `${id}\u0000${itemId}`;
        let collisionId = collisionMapped.get(collisionKey);

        if (collisionId !== undefined) {
          id = collisionId;
        } else if (((states.get(id) ?? 0) & PRESERVED) === 0) {
          // The first distinct original to claim a normalised id keeps it.
          collisionMapped.set(collisionKey, id);
          states.set(id, (states.get(id) ?? 0) | PRESERVED);
        } else {
          const rawNormalized = normalizeItemIdPrefix(item, itemId);

          for (let attempt = 0; ; attempt++) {
            const candidate = withHashSuffix(rawNormalized, attempt);

            if (((states.get(candidate) ?? 0) & OCCUPIED) !== 0) continue;
            collisionId = candidate;
            collisionMapped.set(collisionKey, candidate);
            states.set(candidate, (states.get(candidate) ?? 0) | OCCUPIED | PRESERVED);
            break;
          }

          id = collisionId;
        }
      }

      if (runeLength(id) > ID_LIMIT) {
        let shortened = mapped.get(id);

        if (shortened === undefined) {
          shortened = shorten(id, 0);

          for (let attempt = 1; ((states.get(shortened) ?? 0) & OCCUPIED) !== 0; attempt++) {
            shortened = shorten(id, attempt);
          }

          mapped.set(id, shortened);
          states.set(shortened, (states.get(shortened) ?? 0) | OCCUPIED);
        }

        id = shortened;
      }

      if (id !== itemId) {
        item["id"] = id;
        changed = true;
      }
    }

    rebuilt.push(item);
  }

  if (changed) input.splice(0, input.length, ...rebuilt);

  return body;
};
