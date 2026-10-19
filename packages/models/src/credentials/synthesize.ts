/**
 * Config provider keys -> credentials (including the stable IDs).
 *
 * Go source: internal/watcher/synthesizer/config.go (`ConfigSynthesizer`), helpers.go (`StableIDGenerator`,
 * `ApplyAuthExcludedModelsMeta`, `addConfigHeadersToAttrs`), internal/config/config_normalization.go
 * (`FormatSortedHeaders`). Docs: credentials.md §4.
 *
 * The Workers config groups keys under a shared endpoint (`api-keys.<family>[].keys[]`). Go works on flat entries,
 * so every key is flattened into one entry: settings on the key override the group's (as in `expandV8Groups`).
 * A stored provider key carries its config entry id (`id`, ADR 0025), which is its credential id: editing the key keeps
 * the identity. A key without one (a decoded Go document before the import stores it) gets Go's content hash, so
 * changing key, base URL, proxy, prefix or headers changes the identity; the import stores exactly those ids.
 */
import { createHash } from "node:crypto";
import type {
  ProviderKeyEntry,
  ProviderKeyGroup,
  Config,
  OpenAICompatGroup,
  RequestScopedErrorRule,
} from "../config/schema.ts";
import { normalizeHeaders, normalizeModelPrefix } from "../config/normalize.ts";
import type { JsonObject } from "@commissary/json";
import { type Credential, openAICompatibleProviderKey } from "./model.ts";
import { normalizeExclusions } from "./selection/model-name.ts";
import { DEFAULT_WEIGHT } from "./weight.ts";
import {
  CLOAK_MODE_ATTRIBUTE,
  isOpenCodeProvider,
  OPENCODE_GO,
  OPENCODE_SPECS,
  OPENCODE_ZEN,
} from "../executor/opencode/providers.ts";
import { SUBQ, TYPESAFE } from "../executor/systemone/providers.ts";

/** Go `FormatSortedHeaders`: sorted `name\0value\0` pairs. */
export const formatSortedHeaders = (
  headers: Readonly<Record<string, string>> | undefined,
): string => {
  const names = Object.keys(headers ?? {}).toSorted();

  return names.map((name) => `${name}\0${headers?.[name] ?? ""}\0`).join("");
};

interface GeneratedId {
  readonly id: string;
  readonly token: string;
}

/** Go `StableIDGenerator`: `<kind>:<12 hex of sha256(kind 0 part 0 part ...)>` with `-n` for duplicates. */
export class StableIdGenerator {
  readonly #counters = new Map<string, number>();

  next(kind: string, ...parts: ReadonlyArray<string>): GeneratedId {
    const hash = createHash("sha256");
    hash.update(kind);

    for (const part of parts) {
      hash.update("\0");
      hash.update(part.trim());
    }

    const short = hash.digest("hex").slice(0, 12);
    const key = `${kind}:${short}`;
    const index = this.#counters.get(key) ?? 0;
    this.#counters.set(key, index + 1);
    const token = index > 0 ? `${short}-${index}` : short;

    return { id: `${kind}:${token}`, token };
  }
}

/** A stored entry id as the generator's result: `token` is the part after `<kind>:` (the whole id otherwise). */
const storedId = (kind: string, id: string): GeneratedId => ({
  id,
  token: id.startsWith(`${kind}:`) ? id.slice(kind.length + 1) : id,
});

type Family =
  | "gemini"
  | "interactions"
  | "claude"
  | "codex"
  | "xai"
  | "meta"
  | "opencode-zen"
  | "opencode-go"
  | "typesafe"
  | "subq"
  | "vertex";

interface FamilySpec {
  readonly provider: string;
  readonly idKind: string;
  readonly sourceName: string;
  readonly label: string;
}

const SPECS: Readonly<Record<Family, FamilySpec>> = {
  gemini: {
    provider: "gemini",
    idKind: "gemini:apikey",
    sourceName: "gemini",
    label: "gemini-apikey",
  },
  interactions: {
    provider: "gemini-interactions",
    idKind: "gemini-interactions:apikey",
    sourceName: "interactions",
    label: "interactions-apikey",
  },
  claude: {
    provider: "claude",
    idKind: "claude:apikey",
    sourceName: "claude",
    label: "claude-apikey",
  },
  codex: { provider: "codex", idKind: "codex:apikey", sourceName: "codex", label: "codex-apikey" },
  xai: { provider: "xai", idKind: "xai:apikey", sourceName: "xai", label: "xai-apikey" },
  meta: { provider: "meta", idKind: "meta:apikey", sourceName: "meta", label: "meta-apikey" },
  "opencode-zen": {
    provider: OPENCODE_ZEN,
    idKind: "opencode-zen:apikey",
    sourceName: "opencode-zen",
    label: "opencode-zen-apikey",
  },
  "opencode-go": {
    provider: OPENCODE_GO,
    idKind: "opencode-go:apikey",
    sourceName: "opencode-go",
    label: "opencode-go-apikey",
  },
  typesafe: {
    provider: TYPESAFE,
    idKind: "typesafe:apikey",
    sourceName: "typesafe",
    label: "typesafe-apikey",
  },
  subq: { provider: SUBQ, idKind: "subq:apikey", sourceName: "subq", label: "subq-apikey" },
  vertex: {
    provider: "vertex",
    idKind: "vertex:apikey",
    sourceName: "vertex-apikey",
    label: "vertex-apikey",
  },
};

/** The `<kind>` of the credential ids of `family`'s keys (`group`: an OpenAI-compatible endpoint's name). */
export const providerKeyIdKind = (
  family: Family | "openai-compatibility",
  group: { readonly name?: string | undefined },
): string =>
  family === "openai-compatibility"
    ? `openai-compatibility:${(group.name ?? "").trim().toLowerCase() || "openai-compatibility"}`
    : SPECS[family].idKind;

/** Order in which Go synthesises families; it decides duplicate suffixes only. */
const FAMILY_ORDER: ReadonlyArray<Family> = [
  "gemini",
  "interactions",
  "claude",
  "codex",
  "xai",
  "meta",
  // Not in Go (no OpenCode provider there); after every Go family so Go's duplicate suffixes stay unchanged.
  "opencode-zen",
  "opencode-go",
  // Not in Go (no System One providers there); appended so Go's duplicate suffixes stay unchanged.
  "typesafe",
  "subq",
];

/** Flattened key entry: the group's settings overlaid with the key's own. */
type Flat = ProviderKeyEntry & { readonly "base-url"?: string };

const flatten = (group: ProviderKeyGroup, key: ProviderKeyEntry): Flat => {
  const merged = Object.fromEntries(
    (
      [
        "priority",
        "prefix",
        "proxy-url",
        "headers",
        "models",
        "excluded-models",
        "disable-cooling",
        "request-retry",
        "request-scoped-errors",
      ] as const
    ).flatMap((field) => {
      const value = key[field] ?? group[field];

      return value === undefined ? [] : [[field, value] as const];
    }),
  );

  const base = group["base-url"];

  // Key fields beyond the shared ones (cloak, websockets, ...) come straight from the key.
  return { ...key, ...merged, ...(base === undefined ? {} : { "base-url": base }) };
};

/** `addRequestRetryToMetadata`, `disable_cooling`, `request_scoped_errors`. */
const behaviourMetadata = (fields: {
  readonly disableCooling: boolean | undefined;
  readonly requestRetry: number | undefined;
  readonly rules: ReadonlyArray<RequestScopedErrorRule> | undefined;
}): JsonObject => {
  const metadata: JsonObject = {};

  if (fields.disableCooling !== undefined) metadata.disable_cooling = fields.disableCooling;

  if (fields.requestRetry !== undefined && fields.requestRetry >= 0)
    metadata.request_retry = fields.requestRetry;

  if (fields.rules !== undefined && fields.rules.length > 0) {
    // Go omits empty lists (`omitempty`); the decoded config carries them as empty arrays.
    metadata.request_scoped_errors = fields.rules.map((rule) => {
      const out: JsonObject = {};

      if (rule.status !== undefined) out.status = rule.status;

      if (rule.match !== undefined && rule.match.length > 0) out.match = [...rule.match];

      if (rule["match-regexr"] !== undefined && rule["match-regexr"].length > 0)
        out["match-regexr"] = [...rule["match-regexr"]];

      if (rule.action !== undefined) out.action = rule.action;

      return out;
    });
  }

  return metadata;
};

/** `addWeightToAttrs`: set weights normalise to >= 0; unset means the default weight. */
const weightOf = (weight: number | undefined): { value: number; attribute?: string } =>
  weight === undefined
    ? { value: DEFAULT_WEIGHT }
    : { value: Math.max(0, weight), attribute: String(Math.max(0, weight)) };

const finish = (
  base: Pick<Credential, "id" | "provider" | "label" | "attributes" | "metadata">,
  extra: Partial<Credential> &
    Pick<Credential, "priority" | "weight" | "headers" | "excludedModels">,
  now: number,
): Credential => ({
  source: "config",
  disabled: false,
  modelAliases: [],
  credentialVersion: 1,
  createdAt: now,
  updatedAt: now,
  ...base,
  ...extra,
});

const synthesizeKey = (
  family: Family,
  entry: Flat,
  index: number,
  ids: StableIdGenerator,
  now: number,
): Credential | undefined => {
  const spec = SPECS[family];
  const key = entry["api-key"].trim();
  const configuredBase = (entry["base-url"] ?? "").trim();

  // OpenCode keys always carry their gateway endpoint (the executor reads `base_url`).
  const baseUrl =
    configuredBase === "" && isOpenCodeProvider(family)
      ? OPENCODE_SPECS[family].baseUrl
      : configuredBase;

  // Vertex entries are kept even without a key (the base URL may carry the endpoint).
  if (family !== "vertex" && key === "" && baseUrl === "") return undefined;
  const prefix = normalizeModelPrefix(entry.prefix);
  const proxyUrl = (entry["proxy-url"] ?? "").trim();
  const headers = normalizeHeaders(entry.headers) ?? {};

  const { id, token } =
    entry.id !== undefined
      ? storedId(spec.idKind, entry.id)
      : family === "vertex"
        ? ids.next(spec.idKind, key, baseUrl, proxyUrl)
        : ids.next(spec.idKind, key, baseUrl, proxyUrl, prefix, formatSortedHeaders(headers));

  const attributes: Record<string, string> = {};
  attributes.source = `config:${spec.sourceName}[${token}]`;
  attributes.config_index = String(index);

  if (key !== "") attributes.api_key = key;
  const priority = entry.priority ?? 0;

  if (priority !== 0) attributes.priority = String(priority);
  const weight = weightOf(entry.weight);

  if (weight.attribute !== undefined) attributes.weight = weight.attribute;

  if (family === "vertex") attributes.provider_key = "vertex";

  if (baseUrl !== "" || family === "vertex") attributes.base_url = baseUrl;

  if (family === "claude") {
    if (entry["rebuild-mid-system-message"] === true)
      attributes.rebuild_mid_system_message = "true";
    const profile = (entry["fingerprint-profile"] ?? "").trim().toLowerCase();

    if (profile !== "") attributes.fingerprint_profile = profile;
  }

  if (family === "codex" || family === "xai" || family === "meta") {
    if (entry.websockets === true) attributes.websockets = "true";
  }

  if (family === "codex") {
    if (entry["alpha-search"] === true) attributes.codex_alpha_search = "true";

    if (entry["disable-codex-cloaking"] !== undefined) {
      attributes.codex_disable_cloaking = String(entry["disable-codex-cloaking"]);
    }
  }

  if (family === "vertex" && entry.interactions === true) attributes.interactions = "true";

  // OpenCode Zen free-tier cloak (ADR 0033): registration reads the mode from the credential.
  if (family === OPENCODE_ZEN) {
    const cloakMode = (entry.cloak?.mode ?? "").trim().toLowerCase();

    if (cloakMode !== "") attributes[CLOAK_MODE_ATTRIBUTE] = cloakMode;
  }

  const excludedModels = normalizeExclusions(entry["excluded-models"]);

  if (excludedModels.length > 0) attributes.excluded_models = excludedModels.join(",");
  attributes.auth_kind = "apikey";

  const metadata = behaviourMetadata({
    disableCooling: entry["disable-cooling"],
    requestRetry: entry["request-retry"],
    // Vertex entries carry no request-scoped-errors in Go.
    rules: family === "vertex" ? undefined : entry["request-scoped-errors"],
  });

  return finish(
    { id, provider: spec.provider, label: spec.label, attributes, metadata },
    {
      authKind: "apikey",
      ...(prefix === "" ? {} : { prefix }),
      ...(proxyUrl === "" ? {} : { proxyUrl }),
      priority,
      weight: weight.value,
      headers,
      excludedModels,
      ...(entry.models !== undefined && entry.models.length > 0 ? { models: entry.models } : {}),
    },
    now,
  );
};

const synthesizeCompat = (
  group: OpenAICompatGroup,
  index: number,
  ids: StableIdGenerator,
  now: number,
): Credential[] => {
  if (group.disabled === true) return [];
  const prefix = normalizeModelPrefix(group.prefix);
  const providerName = group.name.trim().toLowerCase() || "openai-compatibility";
  const providerKey = openAICompatibleProviderKey(providerName);
  const baseUrl = group["base-url"].trim();
  const idKind = providerKeyIdKind("openai-compatibility", group);
  const headers = normalizeHeaders(group.headers) ?? {};
  const priority = group.priority ?? 0;
  const models = group.models !== undefined && group.models.length > 0 ? group.models : undefined;

  const metadata = (): JsonObject =>
    behaviourMetadata({
      disableCooling: group["disable-cooling"],
      requestRetry: group["request-retry"],
      rules: group["request-scoped-errors"],
    });

  const build = (
    keyEntry: (typeof group.keys)[number] | undefined,
    generated: { id: string; token: string },
  ): Credential => {
    const attributes: Record<string, string> = {};
    attributes.source = `config:${providerName}[${generated.token}]`;
    attributes.base_url = baseUrl;
    attributes.compat_name = group.name;
    attributes.provider_key = providerKey;
    attributes.config_index = String(index);

    if (priority !== 0) attributes.priority = String(priority);
    const weight = weightOf(keyEntry?.weight);

    if (keyEntry !== undefined && weight.attribute !== undefined)
      attributes.weight = weight.attribute;
    const key = keyEntry?.["api-key"].trim() ?? "";

    if (key !== "") attributes.api_key = key;
    const proxyUrl = (keyEntry?.["proxy-url"] ?? "").trim();

    return finish(
      {
        id: generated.id,
        provider: providerKey,
        label: group.name,
        attributes,
        metadata: metadata(),
      },
      {
        ...(key === "" ? {} : { authKind: "apikey" as const }),
        ...(prefix === "" ? {} : { prefix }),
        ...(proxyUrl === "" ? {} : { proxyUrl }),
        priority,
        weight: weight.value,
        headers,
        excludedModels: [],
        ...(models === undefined ? {} : { models }),
      },
      now,
    );
  };

  // A key-less endpoint has no provider key entry: its credential keeps Go's content hash.
  if (group.keys.length === 0) return [build(undefined, ids.next(idKind, baseUrl))];

  return group.keys.map((keyEntry) =>
    build(
      keyEntry,
      keyEntry.id !== undefined
        ? storedId(idKind, keyEntry.id)
        : ids.next(
            idKind,
            keyEntry["api-key"].trim(),
            baseUrl,
            (keyEntry["proxy-url"] ?? "").trim(),
          ),
    ),
  );
};

/** Synthesises every config provider-key credential in Go's family order. `now` stamps created/updated times. */
export const synthesizeConfigCredentials = (
  config: Pick<Config, "api-keys">,
  now: number,
): Credential[] => {
  const ids = new StableIdGenerator();
  const out: Credential[] = [];
  const keys = config["api-keys"];

  for (const family of FAMILY_ORDER) {
    let index = 0;

    for (const group of keys[family]) {
      for (const key of group.keys) {
        const credential = synthesizeKey(family, flatten(group, key), index, ids, now);

        if (credential !== undefined) out.push(credential);
        index += 1;
      }
    }
  }

  keys["openai-compatibility"].forEach((group, index) =>
    out.push(...synthesizeCompat(group, index, ids, now)),
  );
  let vertexIndex = 0;

  for (const group of keys.vertex) {
    for (const key of group.keys) {
      const credential = synthesizeKey("vertex", flatten(group, key), vertexIndex, ids, now);

      if (credential !== undefined) out.push(credential);
      vertexIndex += 1;
    }
  }

  return out;
};
