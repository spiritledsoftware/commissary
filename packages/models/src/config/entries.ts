/**
 * An org's configuration as config entries (ADR 0025): the pure mapping between a `Config` and the rows the
 * ControlPlane stores (`store.ts`). New in the Workers port, no Go counterpart.
 *
 * Kinds of entry, each a table of its own:
 *
 * - **settings**: one entry per setting, named by its dotted path (`routing.strategy`). The settings are the leaves of
 *   the Settings page (`SETTINGS_TREE`) plus `oauth.settings` and `oauth.request-scoped-errors`, each map one entry.
 *   A setting at its default is not stored.
 * - **key groups** and **provider keys**: a group is its endpoint and shared settings, each key an entry of its own whose id
 *   is its credential id (`credentials/key-ids.ts`); both carry a position that orders them.
 * - **model aliases**, **model exclusions** and **model write-ins**: one entry per channel (`oauth.model-alias.<channel>`,
 *   `oauth.excluded-models.<channel>`, `models.write-ins.<provider>`).
 * - **payload rules**: one entry per rule of `requests.payload`, by kind and position.
 *
 * The not-applied keys (`not-applied.ts`) belong to no entry: a Go config document names them on import and they are
 * not stored. `config-version` is always 8.
 */
import {
  isJsonArray,
  isJsonObject,
  jsonEquals,
  type Json,
  type JsonObject,
  setOwn,
} from "@commissary/json";
import { SETTINGS_TREE } from "@commissary/contract/settings";
import { encodeConfig } from "./codec.ts";
import { PROVIDER_KEY_FAMILIES, type ProviderKeyFamily, Config } from "./schema.ts";
import { Schema } from "effect";

interface Tree {
  readonly [key: string]: Schema.Top | Tree;
}

const leaves = (tree: Tree, prefix: ReadonlyArray<string>): string[] =>
  Object.entries(tree).flatMap(([key, node]) =>
    Schema.isSchema(node) ? [[...prefix, key].join(".")] : leaves(node, [...prefix, key]),
  );

/** Every setting entry's id: its dotted path in the config. */
export const SETTING_PATHS: ReadonlyArray<string> = [
  ...leaves(SETTINGS_TREE, []),
  "oauth.settings",
  "oauth.request-scoped-errors",
];

const SETTINGS = new Set(SETTING_PATHS);

export const isSettingPath = (path: string): boolean => SETTINGS.has(path);

/** The kinds of `requests.payload` rules, in the order the document lists them. */
export const PAYLOAD_KINDS = [
  "default",
  "default-raw",
  "override",
  "override-raw",
  "filter",
] as const;

export type PayloadKind = (typeof PAYLOAD_KINDS)[number];

export interface SettingRow {
  readonly id: string;
  readonly value: Json;
}

export interface GroupRow {
  readonly id: string;
  readonly family: ProviderKeyFamily;
  readonly position: number;
  /** The group without its id and keys. */
  readonly value: JsonObject;
}

export interface KeyRow {
  /** The key's credential id. */
  readonly id: string;
  readonly groupId: string;
  readonly position: number;
  /** The key without its id. */
  readonly value: JsonObject;
}

export interface ChannelRow {
  readonly id: string;
  readonly value: Json;
}

export interface PayloadRow {
  readonly id: string;
  readonly kind: PayloadKind;
  readonly position: number;
  readonly value: Json;
}

/** Every entry of a config, as plain rows (without revisions). */
export interface EntryRows {
  readonly settings: ReadonlyArray<SettingRow>;
  readonly groups: ReadonlyArray<GroupRow>;
  readonly keys: ReadonlyArray<KeyRow>;
  readonly aliases: ReadonlyArray<ChannelRow>;
  readonly exclusions: ReadonlyArray<ChannelRow>;
  readonly writeIns: ReadonlyArray<ChannelRow>;
  readonly payload: ReadonlyArray<PayloadRow>;
}

/** Where each channel rule kind's map lives in the config document. */
export const CHANNEL_RULE_PATHS = {
  aliases: "oauth.model-alias",
  exclusions: "oauth.excluded-models",
  writeIns: "models.write-ins",
} as const;

/** Key settings that are not-applied keys: dropped from a provider key entry (`not-applied.ts`). */
const NOT_APPLIED_KEY_FIELDS = ["experimental-cch-signing"];

/** The value at a dotted path of a JSON document; `undefined` when absent. */
export const atPath = (root: Json, path: string): Json | undefined => {
  let current: Json | undefined = root;

  for (const segment of path.split(".")) {
    if (!isJsonObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }

  return current;
};

/** Writes `value` at a dotted path of `root`, creating sections (own properties only). */
const writePath = (root: JsonObject, path: string, value: Json): void => {
  const segments = path.split(".");
  const last = segments.pop();

  if (last === undefined) return;
  let current = root;

  for (const segment of segments) {
    const next = Object.hasOwn(current, segment) ? current[segment] : undefined;

    if (isJsonObject(next)) current = next;
    else {
      const created: JsonObject = {};
      setOwn(current, segment, created);
      current = created;
    }
  }

  setOwn(current, last, value);
};

let defaultsDocument: JsonObject | undefined;

/** The encoded config of an empty document: what a setting without an entry is. */
export const defaultDocument = (): JsonObject => {
  // SAFETY: the config schema encodes to a plain JSON object.
  defaultsDocument ??= encodeConfig(Schema.decodeUnknownSync(Config)({})) as JsonObject;

  return defaultsDocument;
};

const objectOf = (value: Json | undefined): JsonObject => (isJsonObject(value) ? value : {});

const arrayOf = (value: Json | undefined): Json[] => (isJsonArray(value) ? value : []);

/**
 * The rows of `config`, which must carry an entry id on every key group and provider key (`assignEntryIds`). Payload rules
 * get ids from `payloadId`. Settings at their default, not-applied keys and `config-version` are left out.
 */
export const entriesOfConfig = (config: Config, payloadId: () => string): EntryRows => {
  // SAFETY: the config schema encodes to a plain JSON object.
  const document = encodeConfig(config) as JsonObject;
  const defaults = defaultDocument();

  const settings = SETTING_PATHS.flatMap((id): SettingRow[] => {
    const value = atPath(document, id);

    return value === undefined || jsonEquals(value, atPath(defaults, id)) ? [] : [{ id, value }];
  });

  const groups: GroupRow[] = [];
  const keys: KeyRow[] = [];
  const providerKeys = objectOf(document["api-keys"]);

  for (const family of PROVIDER_KEY_FAMILIES) {
    for (const [position, raw] of arrayOf(providerKeys[family]).entries()) {
      const { id, keys: groupKeys, ...value } = objectOf(raw);

      if (typeof id !== "string") throw new Error(`a ${family} key group has no entry id`);
      groups.push({ id, family, position, value });

      for (const [keyPosition, rawKey] of arrayOf(groupKeys).entries()) {
        const { id: keyId, ...keyValue } = objectOf(rawKey);

        if (typeof keyId !== "string")
          throw new Error(`a provider key of ${family} has no entry id`);

        for (const field of NOT_APPLIED_KEY_FIELDS) delete keyValue[field];
        keys.push({ id: keyId, groupId: id, position: keyPosition, value: keyValue });
      }
    }
  }

  const channels = (path: string): ChannelRow[] =>
    Object.entries(objectOf(atPath(document, path))).map(([id, value]) => ({ id, value }));

  const payloadDocument = objectOf(objectOf(document.requests).payload);

  const payload = PAYLOAD_KINDS.flatMap((kind) =>
    arrayOf(payloadDocument[kind]).map((value, position): PayloadRow => ({
      id: payloadId(),
      kind,
      position,
      value,
    })),
  );

  return {
    settings,
    groups,
    keys,
    aliases: channels(CHANNEL_RULE_PATHS.aliases),
    exclusions: channels(CHANNEL_RULE_PATHS.exclusions),
    writeIns: channels(CHANNEL_RULE_PATHS.writeIns),
    payload,
  };
};

const byPosition = <R extends { readonly position: number; readonly id: string }>(
  a: R,
  b: R,
): number => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The v8 document the rows make up (to be decoded with `decodeConfig`): settings at their paths, key groups and keys
 * by position with their ids, channel rules under `oauth`, payload rules by kind and position.
 */
export const documentOfEntries = (rows: EntryRows): JsonObject => {
  const document: JsonObject = {};

  for (const { id, value } of rows.settings) writePath(document, id, value);

  const keysByGroup = new Map<string, KeyRow[]>();

  for (const key of rows.keys) {
    const list = keysByGroup.get(key.groupId) ?? [];
    list.push(key);
    keysByGroup.set(key.groupId, list);
  }

  const providerKeys: JsonObject = {};

  for (const group of rows.groups.toSorted(byPosition)) {
    const keys = (keysByGroup.get(group.id) ?? [])
      .toSorted(byPosition)
      .map((key): JsonObject => ({ id: key.id, ...key.value }));

    const list = arrayOf(providerKeys[group.family]);
    list.push({ id: group.id, ...group.value, keys });
    providerKeys[group.family] = list;
  }

  if (rows.groups.length > 0) document["api-keys"] = providerKeys;

  const channelMap = (list: ReadonlyArray<ChannelRow>): JsonObject => {
    const map: JsonObject = {};

    for (const { id, value } of list) setOwn(map, id, value);

    return map;
  };

  for (const kind of ["aliases", "exclusions", "writeIns"] as const) {
    if (rows[kind].length > 0)
      writePath(document, CHANNEL_RULE_PATHS[kind], channelMap(rows[kind]));
  }

  if (rows.payload.length > 0) {
    const payload: JsonObject = {};

    for (const rule of rows.payload.toSorted(byPosition)) {
      const list = arrayOf(payload[rule.kind]);
      list.push(rule.value);
      payload[rule.kind] = list;
    }

    writePath(document, "requests.payload", payload);
  }

  return document;
};
