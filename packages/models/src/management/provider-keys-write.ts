/**
 * Pure edits of the assembled config document behind the provider keys page writes (`PUT|DELETE /provider-keys/groups`). They
 * work on a private copy of the JSON document and never see a secret the caller did not already hold:
 *
 * - a key in a written group is `auth_index` (keep the stored secret) and/or `api-key` (new secret). A key of the
 *   written group kept by `auth_index` keeps its entry id, and with it its credential id and `auth_index`, also when
 *   its secret changes (ADR 0025); ids sent by the caller are ignored;
 * - settings the panel never sees (`proxy-url`, `experimental-cch-signing`) and header values it only knows as
 *   `[redacted]…` placeholders are restored from the stored entry, so a write is lossless;
 * - an unknown `auth_index` is a conflict (the key changed identity or is gone since the list was read).
 *
 * The config normaliser drops groups and keys silently (codex without base-url, duplicates, ...); `checkSurvival`
 * compares the normalised result with what was asked for so a structural drop can be refused with the reason instead.
 * Duplicates are the exception, and stored keys win (`settleDuplicates`, `key-duplicates.ts`): a typed key (`api-key`,
 * header values, `proxy-url`, or another `base-url` written for it or its group) that equals a key of another group
 * is dropped from the written group, silently, so the normaliser's first-wins never deletes a stored key to keep a
 * typed one. Refusing it would let an admin confirm a guessed secret (`422` for a right guess, `200` for a wrong one),
 * so the reply is `{status, version}` either way and the next read shows the result. A key kept by `auth_index` that
 * the edit makes equal to a key of another group (by its prefix alone) is a plain `422`.
 * Workers deviation: documented in docs/ARCHITECTURE.md, "Provider keys".
 */
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";
import { DEDUPED_FAMILIES, type DedupedFamily } from "../config/normalize.ts";
import { typedDuplicates, withoutKeys } from "./key-duplicates.ts";
import type { AuthIndexer } from "./auth-index.ts";
import type { ConfigKeyIds, GroupKeyIds } from "../credentials/key-ids.ts";
import { type ProviderKeyFamily, REDACTED_PREFIX } from "@commissary/contract/provider-keys";

export interface EditFailure {
  readonly ok: false;
  readonly status: 404 | 409 | 422;
  /** The error text answered to the panel (the reason for a 422). */
  readonly error: string;
}

export type Edit<A> = { readonly ok: true; readonly value: A } | EditFailure;

const fail = (status: EditFailure["status"], error: string): EditFailure => ({
  ok: false,
  status,
  error,
});

const succeed = <A>(value: A): Edit<A> => ({ ok: true, value });

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/** Settings of a key that do nothing on Workers and are never shown: carried over when a write omits them. */
const HIDDEN_KEY_FIELDS: Readonly<Record<"standard" | "compat", ReadonlyArray<string>>> = {
  standard: ["proxy-url", "experimental-cch-signing"],
  compat: ["proxy-url"],
};

const HIDDEN_GROUP_FIELDS: Readonly<Record<"standard" | "compat", ReadonlyArray<string>>> = {
  standard: ["proxy-url"],
  compat: [],
};

const groupsOf = (document: JsonObject, family: ProviderKeyFamily): JsonObject[] => {
  const providerKeys = document["api-keys"];
  const groups = isJsonObject(providerKeys) ? providerKeys[family] : undefined;

  return Array.isArray(groups) ? groups.filter(isJsonObject) : [];
};

const keysOf = (group: JsonObject): JsonObject[] =>
  Array.isArray(group.keys) ? group.keys.filter(isJsonObject) : [];

interface StoredKey {
  readonly group: JsonObject;
  readonly key: JsonObject;
}

/** The stored key whose credential has `authIndex` (searched through the whole family). */
const findStoredKey = (
  groups: ReadonlyArray<JsonObject>,
  ids: ReadonlyArray<GroupKeyIds>,
  authIndex: string,
  authIndexOf: AuthIndexer,
): StoredKey | undefined => {
  for (const [groupIndex, group] of groups.entries()) {
    for (const [keyIndex, key] of keysOf(group).entries()) {
      const id = ids[groupIndex]?.keys[keyIndex];

      if (id !== undefined && authIndexOf(id) === authIndex) return { group, key };
    }
  }

  return undefined;
};

/** Header values that are still the masked placeholder take the stored value of the same header. */
const restoreHeaders = (
  headers: Json | undefined,
  stored: Json | undefined,
): Edit<Json | undefined> => {
  if (!isJsonObject(headers)) return succeed(headers);
  const out: JsonObject = {};

  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.startsWith(REDACTED_PREFIX)) {
      const original = isJsonObject(stored) ? stored[name] : undefined;

      if (typeof original !== "string")
        return fail(422, `header ${name} carries a masked value and no stored value to keep`);
      out[name] = original;
    } else {
      out[name] = value;
    }
  }

  return succeed(out);
};

const carryOver = (
  out: JsonObject,
  input: JsonObject,
  stored: JsonObject | undefined,
  fields: ReadonlyArray<string>,
): void => {
  if (stored === undefined) return;

  for (const field of fields) {
    const value = stored[field];

    if (!Object.hasOwn(input, field) && value !== undefined) out[field] = value;
  }
};

/** Whether `headers` as sent holds a value other than a masked placeholder: text the caller wrote. */
const writesHeaderValue = (headers: Json | undefined): boolean =>
  isJsonObject(headers) &&
  Object.values(headers).some(
    (value) => !(typeof value === "string" && value.startsWith(REDACTED_PREFIX)),
  );

/**
 * A key of a written group: `typed` when the caller wrote something about it that is secret or points elsewhere: its
 * secret (`api-key`), header values, a `proxy-url`, or (through `groupTyped`) the same for its group or another
 * `base-url`. Anything else is a stored key kept as it is. These all feed the key's uniqueness id, so a collision
 * found by trying a value must never be reported (it would confirm the guess): a typed key is dropped silently.
 */
interface ResolvedKey {
  readonly key: JsonObject;
  readonly typed: boolean;
}

const resolveKey = (
  input: JsonObject,
  compat: boolean,
  existing: JsonObject | undefined,
  groups: ReadonlyArray<JsonObject>,
  ids: ReadonlyArray<GroupKeyIds>,
  authIndexOf: AuthIndexer,
  groupTyped: boolean,
): Edit<ResolvedKey> => {
  const authIndex = text(input.auth_index);
  const stored = authIndex === "" ? undefined : findStoredKey(groups, ids, authIndex, authIndexOf);

  if (authIndex !== "" && stored === undefined) return fail(409, "unknown_auth_index");
  const supplied = input["api-key"];

  if (typeof supplied !== "string" && stored === undefined)
    return fail(422, "every key needs an api-key or an auth_index");

  const { auth_index: _authIndex, "api-key": _providerKey, id: _id, ...rest } = input;
  const secret = typeof supplied === "string" ? supplied : (stored?.key["api-key"] ?? "");
  // A key of the written group keeps its entry id (its credential id); one taken from another group gets a new one.
  const keptId = stored !== undefined && stored.group === existing ? stored.key.id : undefined;

  const out: JsonObject = {
    ...(typeof keptId === "string" ? { id: keptId } : {}),
    "api-key": secret,
    ...rest,
  };

  carryOver(out, input, stored?.key, HIDDEN_KEY_FIELDS[compat ? "compat" : "standard"]);
  const headers = restoreHeaders(out.headers, stored?.key.headers);

  if (!headers.ok) return headers;

  if (headers.value !== undefined) out.headers = headers.value;

  const typed =
    groupTyped ||
    typeof supplied === "string" ||
    writesHeaderValue(input.headers) ||
    Object.hasOwn(input, "proxy-url");

  return succeed({ key: out, typed });
};

/** A written group with its keys resolved; `typed[i]` tells whether `group.keys[i]` was typed. */
interface ResolvedGroup {
  readonly group: JsonObject;
  readonly typed: ReadonlyArray<boolean>;
}

const resolveGroup = (
  document: JsonObject,
  ids: ReadonlyArray<GroupKeyIds>,
  authIndexOf: AuthIndexer,
  family: ProviderKeyFamily,
  index: number | undefined,
  input: JsonObject,
): Edit<ResolvedGroup> => {
  const groups = groupsOf(document, family);
  const existing = index === undefined ? undefined : groups[index];

  if (index !== undefined && existing === undefined) return fail(404, "group not found");
  const compat = family === "openai-compatibility";
  const { keys, id: _id, ...rest } = input;
  const out: JsonObject = { ...rest };
  carryOver(out, input, existing, HIDDEN_GROUP_FIELDS[compat ? "compat" : "standard"]);
  const headers = restoreHeaders(out.headers, existing?.headers);

  if (!headers.ok) return headers;

  if (headers.value !== undefined) out.headers = headers.value;
  const resolved: JsonObject[] = [];
  const typed: boolean[] = [];

  // New text for the whole group (header values, a proxy, another base-url) types every key in it.
  const groupTyped =
    writesHeaderValue(input.headers) ||
    Object.hasOwn(input, "proxy-url") ||
    text(input["base-url"]) !== text(existing?.["base-url"]);

  for (const key of Array.isArray(keys) ? keys : []) {
    if (!isJsonObject(key)) return fail(422, "every key must be an object");
    const result = resolveKey(key, compat, existing, groups, ids, authIndexOf, groupTyped);

    if (!result.ok) return result;
    resolved.push(result.value.key);
    typed.push(result.value.typed);
  }

  out.keys = resolved;

  return succeed({ group: out, typed });
};

/** Copy of `document` with `family`'s group list replaced by `groups`. */
const withGroups = (
  document: JsonObject,
  family: ProviderKeyFamily,
  groups: ReadonlyArray<JsonObject>,
): JsonObject => {
  const out = structuredClone(document);
  const existing = out["api-keys"];
  const providerKeys: JsonObject = isJsonObject(existing) ? existing : {};
  providerKeys[family] = [...groups];
  out["api-keys"] = providerKeys;

  return out;
};

/** A group write applied to the document: the group as written, which of its keys were typed, the new document. */
export interface GroupWrite {
  readonly document: JsonObject;
  readonly group: JsonObject;
  readonly typed: ReadonlyArray<boolean>;
}

/**
 * `document` with `group` written at `index` (appended without one), and the group as stored. `ids` are the
 * credential ids of `document`'s keys (`configKeyIds(config, { includeDisabledGroups: true })`), which `auth_index`
 * entries are resolved against with the deployment's indexer `authIndexOf`. Duplicates are not settled here
 * (`settleDuplicates`).
 */
export const applyGroupWrite = (
  document: JsonObject,
  ids: ConfigKeyIds,
  authIndexOf: AuthIndexer,
  request: {
    readonly family: ProviderKeyFamily;
    readonly index?: number;
    readonly group: JsonObject;
  },
): Edit<GroupWrite> => {
  const resolved = resolveGroup(
    document,
    ids[request.family],
    authIndexOf,
    request.family,
    request.index,
    request.group,
  );

  if (!resolved.ok) return resolved;
  const groups = groupsOf(document, request.family);

  const { group, typed } = resolved.value;

  return succeed({
    group,
    typed,
    document: withGroups(
      document,
      request.family,
      request.index === undefined
        ? [...groups, group]
        : groups.map((existing, position) => (position === request.index ? group : existing)),
    ),
  });
};

/**
 * Stored keys win over typed ones. `identities` are the uniqueness ids (`keyIdentities`) of the families' keys in
 * `write.document` as written, `[group][key]`, for a family whose keys are unique across groups. The written group
 * (`index`, the last group when appended) loses every typed key equal to a key of another group, or to a key it keeps
 * by `auth_index`, or to an earlier typed key: nothing is reported, so the reply cannot tell a right guess of a stored
 * key from a wrong one. A group left without keys is dropped by the normaliser (a new group made of duplicates is
 * never created, a replaced one is removed); the reply is the same `{status, version}` either way. A key kept by
 * `auth_index` that the edit makes equal to a key of another group is refused (`422`) only when the request wrote
 * nothing that feeds the identity but the prefix (no header values, `proxy-url` or other `base-url`, see
 * `ResolvedKey`): the colliding key then differs only by a value the caller can read, so the refusal tells nothing
 * about a secret. Otherwise it is typed and dropped silently like any typed key.
 */
export const settleDuplicates = (
  family: DedupedFamily,
  write: GroupWrite,
  index: number | undefined,
  identities: ReadonlyArray<ReadonlyArray<string>>,
): Edit<GroupWrite> => {
  const position = index ?? identities.length - 1;
  const own = identities[position] ?? [];

  if (own.length !== write.typed.length) return fail(422, "the group could not be checked");

  const others = new Set(identities.flatMap((ids, group) => (group === position ? [] : ids)));

  if (own.some((id, key) => write.typed[key] !== true && others.has(id)))
    return fail(
      422,
      "a key kept in this group would duplicate a key of another group of the family (same key, base-url, proxy-url, prefix and headers)",
    );

  const typed = identities.map((ids, group) =>
    group === position ? write.typed : ids.map(() => false),
  );

  const drops = typedDuplicates(identities, typed);
  const document = withoutKeys(write.document, family, drops);

  if (document === write.document) return succeed(write);
  const marks = drops[position] ?? [];

  return succeed({
    document,
    typed: write.typed.filter((_, key) => marks[key] !== true),
    group: { ...write.group, keys: keysOf(write.group).filter((_, key) => marks[key] !== true) },
  });
};

/** Whether the keys of `family` are unique across its groups (`config/normalize.ts`). */
export const isDedupedFamily = (family: ProviderKeyFamily): family is DedupedFamily =>
  DEDUPED_FAMILIES.some((deduped) => deduped === family);

/** `document` without the group at `index`. */
export const removeGroup = (
  document: JsonObject,
  family: ProviderKeyFamily,
  index: number,
): Edit<JsonObject> => {
  const groups = groupsOf(document, family);

  if (groups[index] === undefined) return fail(404, "group not found");

  return succeed(
    withGroups(
      document,
      family,
      groups.filter((_, position) => position !== index),
    ),
  );
};

/**
 * Why the config normaliser would drop `group` (or some of its keys) for its own shape, whatever is stored;
 * `undefined` when the loss can only be a duplicate (never reported, see the module header).
 */
export const structuralDropReason = (
  family: ProviderKeyFamily,
  group: JsonObject,
): string | undefined => {
  const keys = keysOf(group);
  const baseUrl = text(group["base-url"]);
  const secrets = keys.map((key) => text(key["api-key"]));

  if (
    (family === "codex" || family === "xai" || family === "openai-compatibility") &&
    baseUrl === ""
  )
    return `${family} endpoints need a base-url`;

  if (family === "meta" && secrets.some((secret) => secret === "" || secret.startsWith("dca:")))
    return "meta keys must not be empty or start with dca:";

  if (family === "vertex" && secrets.some((secret) => secret === ""))
    return "vertex keys need an api-key";

  if (
    (family === "opencode-zen" ||
      family === "opencode-go" ||
      family === "typesafe" ||
      family === "subq") &&
    secrets.includes("")
  )
    return `${family} keys need an api-key`;

  if ((family === "gemini" || family === "interactions") && baseUrl === "" && secrets.includes(""))
    return `a ${family} key without an api-key needs a base-url`;

  if (keys.length === 0 && family !== "openai-compatibility") return "add at least one key";

  return undefined;
};

/**
 * Checks the normalised result of a write (`after`: key counts of the family's groups) against what the write asked
 * for: `before` are the counts of the stored groups, `index` the group replaced (appended when undefined), `input` the
 * group as written and `settled` the group once typed duplicates were dropped (`settleDuplicates`).
 *
 * - A group the normaliser would drop for its own shape is refused with the reason (`structuralDropReason`, from
 *   `input` alone), so a write never "succeeds" by losing a key it could not keep.
 * - Every other group must keep its key count: a write may not delete a stored key (the group written is the only
 *   one that changes, whatever was typed).
 * - The group written is gone from the result exactly when `settled` holds no key (all typed keys were duplicates):
 *   that passes and is not reported, because the answer must not depend on whether a typed secret equals a stored one.
 */
export const checkSurvival = (
  family: ProviderKeyFamily,
  before: ReadonlyArray<number>,
  after: ReadonlyArray<number>,
  index: number | undefined,
  input: JsonObject,
  settled: JsonObject = input,
): Edit<null> => {
  const reason = structuralDropReason(family, input);

  if (reason !== undefined) return fail(422, reason);
  const position = index ?? before.length;
  const others = before.filter((_, at) => at !== position);
  const present = family === "openai-compatibility" || keysOf(settled).length > 0;
  const rest = present ? after.filter((_, at) => at !== position) : after;

  const intact =
    after.length === others.length + (present ? 1 : 0) &&
    rest.length === others.length &&
    rest.every((count, at) => count === others[at]);

  return intact ? succeed(null) : fail(422, "this change would remove keys from another group");
};

/** Where in the config a credential id sits: family, group index, key index. */
export interface KeyPosition {
  readonly family: ProviderKeyFamily;
  readonly group: number;
  readonly key: number;
}

export const locateKey = (ids: ConfigKeyIds, id: string): KeyPosition | undefined => {
  for (const [family, groups] of Object.entries(ids)) {
    for (const [group, entry] of groups.entries()) {
      const key = entry.keys.indexOf(id);

      if (key < 0) continue;

      // SAFETY: the keys of `ConfigKeyIds` are exactly the `ProviderKeyFamily` literals.
      return { family: family as ProviderKeyFamily, group, key };
    }
  }

  return undefined;
};
