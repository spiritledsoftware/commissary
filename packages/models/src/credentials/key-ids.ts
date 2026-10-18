/**
 * Which credential each provider key of a config is, and the config entry ids of key groups and provider keys (ADR 0025).
 *
 * `configKeyIds` maps every position in `config["api-keys"]` to the credential the key produced; the ControlPlane and
 * the provider keys view/writes share it, so both agree on which key an `auth_index` names. `assignEntryIds` gives every
 * group and key without one an entry id before the config is stored as entries: a key takes the id of the credential
 * it produces today (Go's content hash, `synthesize.ts`), so importing or migrating a config keeps every credential
 * id, and with it cooldowns, usage `auth_id` and auth indexes.
 */
import { Schema } from "effect";
import { encodeConfig } from "../config/codec.ts";
import { type ProviderKeyFamily, Config } from "../config/schema.ts";
import { isJsonArray, isJsonObject, type JsonObject } from "@commissary/json";
import { providerKeyIdKind, synthesizeConfigCredentials } from "./synthesize.ts";

const FAMILY_PROVIDERS: Readonly<
  Record<Exclude<ProviderKeyFamily, "openai-compatibility">, string>
> = {
  gemini: "gemini",
  interactions: "gemini-interactions",
  vertex: "vertex",
  codex: "codex",
  claude: "claude",
  xai: "xai",
  meta: "meta",
  "opencode-zen": "opencode-zen",
  "opencode-go": "opencode-go",
  typesafe: "typesafe",
  subq: "subq",
};

/** Credential ids of one group: one per key (`undefined` when the key produced no credential). */
export interface GroupKeyIds {
  readonly keys: ReadonlyArray<string | undefined>;
  /** A key-less OpenAI-compatibility group still produces one credential: its id. */
  readonly group?: string;
}

/** Per family and group index: the ids of the credentials `synthesizeConfigCredentials` made for them. */
export type ConfigKeyIds = Readonly<Record<ProviderKeyFamily, ReadonlyArray<GroupKeyIds>>>;

export interface ConfigKeyIdsOptions {
  /**
   * Also give the keys of a disabled OpenAI-compatibility group an id (as if the group were enabled), so the panel
   * can still address them. Off by default: a disabled group has no credentials (as in Go).
   */
  readonly includeDisabledGroups?: boolean;
}

/**
 * Maps every position in `config["api-keys"]` (family, group, key) to the id of the credential it produced, through
 * the synthesised credentials (`attributes.config_index`), the same order the credential pool uses. Shared by the
 * ControlPlane and the provider keys view/writes, so both agree on which key an `auth_index` names.
 */
export const configKeyIds = (
  config: Pick<Config, "api-keys">,
  options: ConfigKeyIdsOptions = {},
): ConfigKeyIds => {
  const providerKeys = config["api-keys"];

  const synthesised: Pick<Config, "api-keys"> =
    options.includeDisabledGroups === true
      ? {
          "api-keys": {
            ...providerKeys,
            "openai-compatibility": providerKeys["openai-compatibility"].map((group) =>
              group.disabled === true ? { ...group, disabled: false } : group,
            ),
          },
        }
      : config;

  const byPosition = new Map<string, string>();
  const compat = new Map<string, string[]>();

  for (const credential of synthesizeConfigCredentials(synthesised, 0)) {
    const index = credential.attributes.config_index;

    if (index === undefined) continue;

    if (credential.attributes.compat_name !== undefined) {
      const list = compat.get(index) ?? [];
      list.push(credential.id);
      compat.set(index, list);
    } else {
      byPosition.set(`${credential.provider}:${index}`, credential.id);
    }
  }

  const grouped = (family: Exclude<ProviderKeyFamily, "openai-compatibility">): GroupKeyIds[] => {
    const provider = FAMILY_PROVIDERS[family];
    let position = 0;

    return providerKeys[family].map((group) => ({
      keys: group.keys.map(() => {
        const id = byPosition.get(`${provider}:${position}`);
        position += 1;

        return id;
      }),
    }));
  };

  return {
    gemini: grouped("gemini"),
    interactions: grouped("interactions"),
    vertex: grouped("vertex"),
    codex: grouped("codex"),
    claude: grouped("claude"),
    xai: grouped("xai"),
    meta: grouped("meta"),
    "opencode-zen": grouped("opencode-zen"),
    "opencode-go": grouped("opencode-go"),
    typesafe: grouped("typesafe"),
    subq: grouped("subq"),
    "openai-compatibility": providerKeys["openai-compatibility"].map((group, index) => {
      const ids = compat.get(String(index)) ?? [];

      return {
        keys: group.keys.map((_, keyIndex) => ids[keyIndex]),
        ...(group.keys.length === 0 && ids[0] !== undefined ? { group: ids[0] } : {}),
      };
    }),
  };
};

/** A fresh random entry id `<kind>:<24 hex>` (never a content hash: it says nothing about the entry). */
export const freshEntryId = (kind: string): string =>
  `${kind}:${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

/** The id kind of key groups (random ids; a group is no credential). */
export const GROUP_ID_KIND = "group";

/**
 * `config` with an entry id on every key group and provider key. Ids already set are kept; a duplicate keeps its first
 * holder and the later one gets a fresh id. A key without one takes the id of the credential it produces
 * (`configKeyIds`; for the keys of a disabled OpenAI-compatible endpoint, the id it would produce enabled), and a key
 * that produces no credential (an empty key without a base URL) a fresh one. No id is one of `taken` (ids held
 * outside `config`). `fresh` makes fresh ids (`freshEntryId` by default; tests pass a deterministic one).
 */
export const assignEntryIds = (
  config: Config,
  fresh: (kind: string) => string = freshEntryId,
  taken: ReadonlySet<string> = new Set(),
): Config => {
  const enabled = configKeyIds(config);
  const all = configKeyIds(config, { includeDisabledGroups: true });
  // Every stored id is reserved first, so a derived id never takes one another entry already holds.
  const reserved = new Set(taken);
  const used = new Set(taken);

  for (const groups of Object.values(config["api-keys"]))
    for (const group of groups) {
      if (group.id !== undefined) reserved.add(group.id);

      for (const key of group.keys) if (key.id !== undefined) reserved.add(key.id);
    }

  const claimStored = (id: string, kind: string): string => {
    if (!used.has(id)) {
      used.add(id);

      return id;
    }

    return claimFresh(kind);
  };

  const claimFresh = (kind: string): string => {
    let chosen = fresh(kind);

    while (used.has(chosen) || reserved.has(chosen)) chosen = fresh(kind);
    used.add(chosen);

    return chosen;
  };

  const claim = (id: string | undefined, stored: string | undefined, kind: string): string => {
    if (stored !== undefined) return claimStored(stored, kind);

    if (id === undefined || used.has(id) || reserved.has(id)) return claimFresh(kind);
    used.add(id);

    return id;
  };

  const keyIdOf = (family: ProviderKeyFamily, group: number, key: number): string | undefined =>
    enabled[family][group]?.keys[key] ?? all[family][group]?.keys[key];

  const withIds = <
    G extends {
      readonly id?: string | undefined;
      readonly name?: string | undefined;
      readonly keys: ReadonlyArray<{ readonly id?: string | undefined }>;
    },
  >(
    family: ProviderKeyFamily,
    groups: ReadonlyArray<G>,
  ): G[] =>
    groups.map((group, groupIndex) => ({
      ...group,
      id: claim(undefined, group.id, GROUP_ID_KIND),
      keys: group.keys.map((key, keyIndex) => ({
        ...key,
        id: claim(keyIdOf(family, groupIndex, keyIndex), key.id, providerKeyIdKind(family, group)),
      })),
    }));

  const providerKeys = config["api-keys"];

  return {
    ...config,
    "api-keys": {
      gemini: withIds("gemini", providerKeys.gemini),
      interactions: withIds("interactions", providerKeys.interactions),
      vertex: withIds("vertex", providerKeys.vertex),
      codex: withIds("codex", providerKeys.codex),
      claude: withIds("claude", providerKeys.claude),
      xai: withIds("xai", providerKeys.xai),
      meta: withIds("meta", providerKeys.meta),
      "opencode-zen": withIds("opencode-zen", providerKeys["opencode-zen"]),
      "opencode-go": withIds("opencode-go", providerKeys["opencode-go"]),
      typesafe: withIds("typesafe", providerKeys.typesafe),
      subq: withIds("subq", providerKeys.subq),
      "openai-compatibility": withIds("openai-compatibility", providerKeys["openai-compatibility"]),
    },
  };
};

/**
 * `config` (an imported document, without ids) with each provider key taking the id of the stored key of its family with
 * the same secret, each stored id at most once. A key whose secret was edited in the panel kept its id while its
 * content hash changed, so a later import of a document with that secret keeps its credential id and auth index too.
 */
export const withStoredKeyIds = (config: Config, stored: Config): Config => {
  const withIds = <G extends { readonly keys: ReadonlyArray<StoredKey> }>(
    groups: ReadonlyArray<G>,
    storedGroups: ReadonlyArray<{ readonly keys: ReadonlyArray<StoredKey> }>,
  ): G[] => {
    const ids = new Map<string, string>();

    for (const group of storedGroups)
      for (const key of group.keys)
        if (key.id !== undefined && !ids.has(key["api-key"])) ids.set(key["api-key"], key.id);

    return groups.map((group) => ({
      ...group,
      keys: group.keys.map((key) => {
        const id = key.id ?? ids.get(key["api-key"]);

        if (id === undefined) return key;
        ids.delete(key["api-key"]);

        return { ...key, id };
      }),
    }));
  };

  const providerKeys = config["api-keys"];
  const storedKeys = stored["api-keys"];

  return {
    ...config,
    "api-keys": {
      gemini: withIds(providerKeys.gemini, storedKeys.gemini),
      interactions: withIds(providerKeys.interactions, storedKeys.interactions),
      vertex: withIds(providerKeys.vertex, storedKeys.vertex),
      codex: withIds(providerKeys.codex, storedKeys.codex),
      claude: withIds(providerKeys.claude, storedKeys.claude),
      xai: withIds(providerKeys.xai, storedKeys.xai),
      meta: withIds(providerKeys.meta, storedKeys.meta),
      "opencode-zen": withIds(providerKeys["opencode-zen"], storedKeys["opencode-zen"]),
      "opencode-go": withIds(providerKeys["opencode-go"], storedKeys["opencode-go"]),
      typesafe: withIds(providerKeys.typesafe, storedKeys.typesafe),
      subq: withIds(providerKeys.subq, storedKeys.subq),
      "openai-compatibility": withIds(
        providerKeys["openai-compatibility"],
        storedKeys["openai-compatibility"],
      ),
    },
  };
};

interface StoredKey {
  readonly id?: string | undefined;
  readonly "api-key": string;
}

/** `config` without entry ids (a Go config document never carries them; the import assigns its own). */
export const withoutEntryIds = (config: Config): Config => {
  // SAFETY: the config schema encodes to a plain JSON object.
  const document = structuredClone(encodeConfig(config)) as JsonObject;
  const providerKeys = document["api-keys"];

  for (const groups of isJsonObject(providerKeys) ? Object.values(providerKeys) : [])
    for (const group of isJsonArray(groups) ? groups : []) {
      if (!isJsonObject(group)) continue;
      delete group.id;

      for (const key of isJsonArray(group.keys) ? group.keys : [])
        if (isJsonObject(key)) delete key.id;
    }

  return Schema.decodeUnknownSync(Config)(document);
};
