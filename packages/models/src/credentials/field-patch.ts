/**
 * Dotted-path edits of an auth file (`PATCH /v9/management/credentials/fields`).
 *
 * Go source: internal/api/handlers/management/auth_files_fields.go (`PatchAuthFileFields`,
 * `normalizeAuthFilePatchFields`, `decodeAuthFileRequestRetryPatch`, `setAuthFileMetadataValue`,
 * `applyAuthFileHeadersPatch`). The patch is applied to a copy of the stored metadata; `null` deletes a field.
 *
 * Differences from Go:
 * - token lifecycle keys, `type` and `disabled` are rejected (they have dedicated endpoints and must not be forged
 *   through a settings editor);
 * - the routing fields the control panel edits are type-checked instead of stored as sent, and a bad value names its
 *   field (`path`, answered as `422`; `headers.<name>` and `model_aliases.<index>` name the entry): `prefix` (a string;
 *   outer slashes dropped like the synthesizer, then no `/` or spaces; empty deletes), `disable_cooling` and
 *   `websockets` (booleans), `excluded_models` (strings without spaces; stored trimmed, lower-cased and de-duplicated
 *   as selection reads them; empty deletes), `model_aliases` (`{name, alias, fork?, force-mapping?, display-name?}`
 *   with both names set, different, and each alias once; empty deletes) and `headers` (a string map with valid header
 *   names and single-line values, merged with names matched case-insensitively; an empty value removes a header
 *   whatever its stored name; Go replaced the whole map with anything that was not a string map);
 * - nested paths into those fields (`headers.X-Foo`, `prefix.x`) are refused with `400` (Go set the nested value);
 * - a header value that is the masked view of the stored value of the same header (`[redacted]…abcd`, what
 *   `GET /credentials` shows) keeps the stored value; any other value containing `[redacted` or `[new secret` is
 *   refused, so a masked secret is never stored as a value nor copied to another header.
 */
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";
import { extractHeaders } from "./derive.ts";
import { canonicalMetadataKey } from "./import.ts";
import { isTokenPayloadKey } from "./merge.ts";
import { PLACEHOLDER } from "@commissary/contract/headers";
import { maskHeaders } from "./summary.ts";
import { parseWeightValue } from "./weight.ts";

export type FieldPatchResult =
  | { readonly ok: true; readonly metadata: JsonObject }
  | {
      readonly ok: false;
      readonly message: string;
      /** The field a refused value belongs to (canonical spelling); absent for a malformed request. */
      readonly path?: string;
    };

type Refusal = Extract<FieldPatchResult, { ok: false }>;

const PROTECTED_ROOTS = new Set([
  "type",
  "disabled",
  "api_key",
  "dca_token",
  "dca_expired",
  "dca_expires_at",
]);

/** RFC 9110 `token`: what `Headers` accepts as a name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const refuse = (path: string, message: string): Refusal => ({ ok: false, message, path });

const rootOf = (path: string): string => {
  const dot = path.indexOf(".");

  return (dot < 0 ? path : path.slice(0, dot)).trim();
};

/** Canonical (snake_case) spelling of the root segment; every segment is trimmed. */
const normalizePath = (key: string): string => {
  const parts = key
    .trim()
    .split(".")
    .map((part) => part.trim());

  parts[0] = canonicalMetadataKey(parts[0] ?? "");

  return parts.join(".");
};

const setAt = (metadata: JsonObject, path: string, value: Json): string | undefined => {
  const parts = path.split(".").map((part) => part.trim());

  if (parts.some((part) => part === "")) return `invalid field path: ${path}`;
  let current = metadata;

  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) {
      if (value === null) delete current[part];
      else current[part] = value;

      return undefined;
    }

    const next = current[part];

    if (isJsonObject(next)) {
      current = next;
    } else {
      if (value === null) return undefined;
      const created: JsonObject = {};
      current[part] = created;
      current = created;
    }
  }

  return undefined;
};

/**
 * `applyAuthFileHeadersPatch`: a string map merges into the stored headers (an empty value deletes one). A value
 * equal to the masked view of the same header's stored value keeps it.
 */
const patchHeaders = (metadata: JsonObject, value: Json): Refusal | undefined => {
  if (value === null) {
    delete metadata.headers;

    return undefined;
  }

  if (!isJsonObject(value)) return refuse("headers", "headers must be a map of names to values");
  const next = extractHeaders(metadata.headers);
  const masked = maskHeaders(next);

  for (const [key, item] of Object.entries(value)) {
    const name = key.trim();
    const at = `headers.${name}`;

    if (typeof item !== "string") return refuse(at, `header ${name} must have a text value`);
    const headerValue = item.trim();
    // Names match like HTTP's: case-insensitively, for replacing and for removing.
    const stored = Object.keys(next).filter((known) => known.toLowerCase() === name.toLowerCase());

    // An empty value removes the header, whatever its stored name looks like.
    if (headerValue === "") {
      for (const known of stored) delete next[known];
      continue;
    }

    if (name === "") return refuse("headers", "a header with a value needs a name");

    if (!HEADER_NAME.test(name)) return refuse(at, `“${name}” is not a valid header name`);

    if (/[\r\n]/.test(headerValue)) return refuse(at, `header ${name} must be a single line`);

    if (headerValue.includes("\0"))
      return refuse(at, `header ${name} cannot contain a NUL character`);

    // The mask of the same header's stored value keeps it, under the spelling sent (a case-only rename lands).
    const kept = stored.find((known) => masked[known] === headerValue);

    if (kept !== undefined) {
      const value = next[kept];

      for (const known of stored) delete next[known];

      if (value !== undefined) next[name] = value;
      continue;
    }

    if (PLACEHOLDER.test(headerValue)) {
      return refuse(
        at,
        `header ${name} carries a hidden value that is not its own; type the value again`,
      );
    }

    for (const known of stored) delete next[known];
    next[name] = headerValue;
  }

  if (Object.keys(next).length === 0) delete metadata.headers;
  else metadata.headers = next;

  return undefined;
};

const patchPrefix = (metadata: JsonObject, value: Json): Refusal | undefined => {
  if (value === null) {
    delete metadata.prefix;

    return undefined;
  }

  if (typeof value !== "string") return refuse("prefix", "prefix must be text or null");
  // Outer slashes are dropped like Go's synthesizer (`strings.Trim(prefix, "/")`); one inside is refused.
  const prefix = value.trim().replace(/^\/+|\/+$/g, "");

  if (prefix.includes("/")) return refuse("prefix", "prefix cannot contain /");

  if (/\s/.test(prefix)) return refuse("prefix", "prefix cannot contain spaces");

  if (prefix === "") delete metadata.prefix;
  else metadata.prefix = prefix;

  return undefined;
};

const patchFlag = (metadata: JsonObject, path: string, value: Json): Refusal | undefined => {
  if (value === null) delete metadata[path];
  else if (typeof value === "boolean") metadata[path] = value;
  else return refuse(path, `${path} must be true, false or null`);

  return undefined;
};

const patchExclusions = (metadata: JsonObject, value: Json): Refusal | undefined => {
  if (value === null) {
    delete metadata.excluded_models;

    return undefined;
  }

  const items = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

  if (!Array.isArray(value) || items.length !== value.length)
    return refuse("excluded_models", "excluded_models must be a list of model names or patterns");
  const patterns: string[] = [];

  for (const item of items) {
    const pattern = item.trim().toLowerCase();

    if (pattern === "" || patterns.includes(pattern)) continue;

    if (/\s/.test(pattern))
      return refuse("excluded_models", `“${pattern}” has a space; a pattern has none`);
    patterns.push(pattern);
  }

  if (patterns.length === 0) delete metadata.excluded_models;
  else metadata.excluded_models = patterns;

  return undefined;
};

const optionalText = (value: Json | undefined): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const patchAliases = (metadata: JsonObject, value: Json): Refusal | undefined => {
  if (value === null) {
    delete metadata.model_aliases;

    return undefined;
  }

  if (!Array.isArray(value))
    return refuse("model_aliases", "model_aliases must be a list of aliases");
  const entries: JsonObject[] = [];
  const seen = new Map<string, string>();

  for (const [index, item] of value.entries()) {
    const at = `model_aliases.${index}`;

    if (!isJsonObject(item) || typeof item.name !== "string" || typeof item.alias !== "string")
      return refuse(at, "each alias needs a name and an alias");
    const name = item.name.trim();
    const alias = item.alias.trim();

    if (name === "" || alias === "")
      return refuse(at, "each alias needs the provider's model name and the alias");

    // A case-only alias is allowed (34d8fe0f).
    if (name === alias) return refuse(at, `the alias ${alias} is the model's own name`);
    const taken = seen.get(alias.toLowerCase());

    if (taken !== undefined)
      return refuse(at, `the alias ${alias} is already the alias of ${taken}`);

    for (const flag of ["fork", "force-mapping"] as const) {
      if (item[flag] !== undefined && typeof item[flag] !== "boolean")
        return refuse(at, `${flag} of the alias ${alias} must be true or false`);
    }

    seen.set(alias.toLowerCase(), name);
    const displayName = optionalText(item["display-name"]);

    entries.push({
      name,
      alias,
      ...(item.fork === true ? { fork: true } : {}),
      ...(item["force-mapping"] === true ? { "force-mapping": true } : {}),
      ...(displayName === undefined ? {} : { "display-name": displayName }),
    });
  }

  if (entries.length === 0) delete metadata.model_aliases;
  else metadata.model_aliases = entries;

  return undefined;
};

/** The typed routing fields, by canonical path; each refuses a bad value with its path. */
const TYPED = new Map<
  string,
  (metadata: JsonObject, path: string, value: Json) => Refusal | undefined
>([
  ["prefix", (metadata, _path, value) => patchPrefix(metadata, value)],
  ["disable_cooling", patchFlag],
  ["websockets", patchFlag],
  ["excluded_models", (metadata, _path, value) => patchExclusions(metadata, value)],
  ["model_aliases", (metadata, _path, value) => patchAliases(metadata, value)],
  ["headers", (metadata, _path, value) => patchHeaders(metadata, value)],
]);

/**
 * Applies `fields` (request body without `name`) to `existing` and returns the new metadata.
 * Validation messages are the Go error strings where Go has one.
 */
export const applyFieldPatch = (
  existing: JsonObject,
  fields: Readonly<Record<string, Json>>,
): FieldPatchResult => {
  const metadata = structuredClone(existing);
  const normalized = new Map<string, Json>();
  const spelled = new Map<string, string>();

  for (const [key, value] of Object.entries(fields)) {
    if (key.trim() === "") return { ok: false, message: "field name is required" };
    const path = normalizePath(key);
    const previous = spelled.get(path);

    if (previous !== undefined) {
      return {
        ok: false,
        message: `auth file fields "${previous}" and "${key}" refer to the same field`,
      };
    }

    spelled.set(path, key);
    normalized.set(path, value);
  }

  if (normalized.size === 0) return { ok: false, message: "no fields to update" };

  for (const [path, value] of normalized) {
    const root = rootOf(path);

    if (PROTECTED_ROOTS.has(root) || isTokenPayloadKey(root))
      return { ok: false, message: `invalid field ${path}` };
    const typed = TYPED.get(root);

    if (root === "request_retry") {
      if (path !== root)
        return { ok: false, message: "request_retry does not support nested fields" };

      if (value === null) {
        delete metadata.request_retry;
      } else if (typeof value === "number" && Number.isSafeInteger(value)) {
        // Negative values mean "no override" in Go.
        if (value < 0) delete metadata.request_retry;
        else metadata.request_retry = value;
      } else {
        return refuse("request_retry", "request_retry must be an integer or null");
      }
    } else if (path === "weight") {
      if (value === null) {
        delete metadata.weight;
      } else {
        if (typeof value !== "number") return refuse("weight", "weight must be an integer");
        const weight = parseWeightValue(value);

        if (!weight.ok) return refuse("weight", weight.message);
        metadata.weight = weight.value;
      }
    } else if (root === "weight") {
      return { ok: false, message: "weight does not support nested fields" };
    } else if (typed !== undefined) {
      if (path !== root) return { ok: false, message: `${root} does not support nested fields` };
      const refused = typed(metadata, path, value);

      if (refused !== undefined) return refused;
    } else {
      const error = setAt(metadata, path, value);

      if (error !== undefined) return { ok: false, message: error };
    }
  }

  return { ok: true, metadata };
};
