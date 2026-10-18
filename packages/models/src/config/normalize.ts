/**
 * Post-decode normalisation of a decoded {@link Config}.
 *
 * Go source: internal/config/config_load.go (clamps), config_normalization.go (Sanitize*), config_validation.go
 * (SanitizePayloadRules). Applied once when a document is imported/stored so readers see canonical values.
 * Workers additions (no Go counterpart): OpenCode keys without a secret are dropped, and a model entry's `protocol`
 * (OpenCode-only) is dropped in every other provider section.
 */
import { tryParseJson } from "@commissary/json";
import type {
  ProviderKeyEntry,
  ProviderKeyFamily,
  ProviderKeyGroup,
  Config,
  ModelEntry,
  OAuthModelAlias,
  OAuthModelSetting,
  OpenAICompatGroup,
  RequestScopedErrorRule,
} from "./schema.ts";
import type { PayloadRule } from "./payload/schema.ts";

const DEFAULT_META_BASE_URL = "https://api.meta.ai/v1";

/** Trims, strips surrounding `/`, and rejects prefixes that still contain `/`. */
export const normalizeModelPrefix = (prefix: string | undefined): string => {
  const trimmed = (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");

  return trimmed.includes("/") ? "" : trimmed;
};

/** Trims header names and values and drops empty pairs; `undefined` when nothing is left. */
export const normalizeHeaders = (
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined => {
  const clean: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers ?? {})) {
    const k = key.trim();
    const v = value.trim();

    if (k !== "" && v !== "") clean[k] = v;
  }

  return Object.keys(clean).length === 0 ? undefined : clean;
};

/** Trims, lowercases and deduplicates model exclusion patterns (first occurrence wins). */
export const normalizeExcludedModels = (
  models: readonly string[] | undefined,
): string[] | undefined => {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of models ?? []) {
    const value = raw.trim().toLowerCase();

    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out.length === 0 ? undefined : out;
};

const trimmedOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/** Builds an object without `undefined` values (required by `exactOptionalPropertyTypes`). */
const compact = <T extends object>(value: { [K in keyof T]: T[K] | undefined }): T =>
  // SAFETY: only undefined-valued keys are dropped, so every remaining property keeps its declared type in T.
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

const normalizeScopedErrors = (
  rules: readonly RequestScopedErrorRule[] | undefined,
): RequestScopedErrorRule[] | undefined => {
  if (rules === undefined) return undefined;
  const clean: RequestScopedErrorRule[] = [];

  for (const rule of rules) {
    const action = (rule.action ?? "").trim().toLowerCase();
    const match = (rule.match ?? []).map((m) => m.trim()).filter((m) => m !== "");
    const matchRegexr = (rule["match-regexr"] ?? []).map((m) => m.trim()).filter((m) => m !== "");

    const status = rule.status ?? 0;

    if (status <= 0 || (match.length === 0 && matchRegexr.length === 0) || action === "") continue;
    clean.push({ status, match, "match-regexr": matchRegexr, action });
  }

  return clean;
};

const normalizeGroup = (group: ProviderKeyGroup): ProviderKeyGroup => {
  const headers = normalizeHeaders(group.headers);
  const excluded = normalizeExcludedModels(group["excluded-models"]);
  const prefix = group.prefix === undefined ? undefined : normalizeModelPrefix(group.prefix);
  const scoped = normalizeScopedErrors(group["request-scoped-errors"]);

  // SAFETY: the spread keeps every ProviderKeyGroup field; the overrides only differ by explicit undefined values.
  return {
    ...group,
    name: trimmedOrUndefined(group.name),
    "base-url": trimmedOrUndefined(group["base-url"]),
    prefix,
    headers,
    "excluded-models": excluded,
    "request-scoped-errors": scoped,
    keys: group.keys.map((key) => ({
      ...key,
      "api-key": key["api-key"].trim(),
      ...(key.prefix === undefined ? {} : { prefix: normalizeModelPrefix(key.prefix) }),
      ...(key.headers === undefined ? {} : { headers: normalizeHeaders(key.headers) ?? {} }),
      ...(key["excluded-models"] === undefined
        ? {}
        : { "excluded-models": normalizeExcludedModels(key["excluded-models"]) ?? [] }),
      ...(key.cloak === undefined
        ? {}
        : {
            cloak: compact({
              ...key.cloak,
              mode: trimmedOrUndefined(key.cloak.mode),
              "sensitive-words": key.cloak["sensitive-words"]
                ?.map((word) => word.trim())
                .filter((word) => word !== ""),
            }),
          }),
    })),
  } as ProviderKeyGroup;
};

/** `FormatSortedHeaders`: order-independent header identity (key/value pairs, NUL separated). */
const sortedHeadersId = (headers: Readonly<Record<string, string>> | undefined): string =>
  Object.keys(headers ?? {})
    .toSorted()
    .map((name) => `${name}\0${headers?.[name] ?? ""}\0`)
    .join("");

/** Vertex models need both a name and an alias (`SanitizeVertexCompatKeys`). */
const modelsWithAliasAndName = (
  models: readonly ModelEntry[] | undefined,
): { models?: ModelEntry[] } =>
  models === undefined
    ? {}
    : {
        models: models.filter(
          (model) => model.name.trim() !== "" && (model.alias ?? "").trim() !== "",
        ),
      };

const withVertexModels = (key: ProviderKeyEntry): ProviderKeyEntry => ({
  ...key,
  ...modelsWithAliasAndName(key.models),
});

/**
 * Removes duplicate keys across the whole flattened family (Go sanitises the flat list): `identity` maps a key and its
 * group to the Go uniqueness id; the first occurrence wins and groups left without keys are dropped.
 */
const dedupeAcrossGroups = (
  groups: readonly ProviderKeyGroup[],
  identity: (group: ProviderKeyGroup, key: ProviderKeyEntry) => string,
): ProviderKeyGroup[] => {
  const seen = new Set<string>();
  const out: ProviderKeyGroup[] = [];

  for (const group of groups) {
    const keys = group.keys.filter((key) => {
      const id = identity(group, key);

      if (seen.has(id)) return false;
      seen.add(id);

      return true;
    });

    if (keys.length > 0) out.push({ ...group, keys });
  }

  return out;
};

/** `formatGeminiKeyDedupID`: key, base URL, proxy, prefix and sorted headers (entry values override the group's). */
const geminiIdentity = (group: ProviderKeyGroup, key: ProviderKeyEntry): string =>
  [
    key["api-key"],
    group["base-url"] ?? "",
    (key["proxy-url"] ?? group["proxy-url"] ?? "").trim(),
    key.prefix ?? group.prefix ?? "",
    sortedHeadersId(key.headers ?? group.headers),
  ].join("\0");

/** Vertex keys are unique by key and base URL (`SanitizeVertexCompatKeys`). */
const vertexIdentity = (group: ProviderKeyGroup, key: ProviderKeyEntry): string =>
  `${key["api-key"]}|${group["base-url"] ?? ""}`;

/** The families whose keys Go deduplicates across groups (the others keep every key). */
export type DedupedFamily = "gemini" | "interactions" | "vertex";

export const DEDUPED_FAMILIES: ReadonlyArray<DedupedFamily> = ["gemini", "interactions", "vertex"];

const IDENTITY: Readonly<
  Record<DedupedFamily, (group: ProviderKeyGroup, key: ProviderKeyEntry) => string>
> = { gemini: geminiIdentity, interactions: geminiIdentity, vertex: vertexIdentity };

/**
 * The uniqueness id of every key of the `family` groups of `config` as normalisation computes it (group and key
 * fields normalised first), indexed `[group][key]`. `config` is a decode that is not normalised yet
 * (`decodeRawConfig`), so the indexes are those of the document. The normaliser keeps the first key of an id; the
 * management writes use these ids to keep the stored one instead (`management/key-duplicates.ts`).
 */
export const keyIdentities = (
  family: DedupedFamily,
  config: Config,
): ReadonlyArray<ReadonlyArray<string>> =>
  config["api-keys"][family].map((raw) => {
    const group = normalizeGroup(raw);

    return group.keys.map((key) => IDENTITY[family](group, key));
  });

/** Model entries without `protocol` (an OpenCode-only field, ignored elsewhere). */
const withoutProtocol = (models: readonly ModelEntry[] | undefined): ModelEntry[] | undefined =>
  models?.map(({ protocol: _ignored, ...model }) => model);

const groupWithoutProtocol = (group: ProviderKeyGroup): ProviderKeyGroup =>
  compact<ProviderKeyGroup>({
    ...group,
    models: withoutProtocol(group.models),
    keys: group.keys.map((key) =>
      compact<ProviderKeyEntry>({ ...key, models: withoutProtocol(key.models) }),
    ),
  });

/** Applies the per-family rules of config_normalization.go to the grouped layout. */
const normalizeFamily = (
  family: Exclude<ProviderKeyFamily, "openai-compatibility">,
  groups: readonly ProviderKeyGroup[],
): ProviderKeyGroup[] => {
  const out: ProviderKeyGroup[] = [];

  for (const raw of groups) {
    const normalized = compact<ProviderKeyGroup>(normalizeGroup(raw));

    // Deviation (no Go counterpart): `protocol` only means something to the OpenCode gateways.
    const group =
      family === "opencode-zen" || family === "opencode-go"
        ? normalized
        : groupWithoutProtocol(normalized);

    if ((family === "codex" || family === "xai") && group["base-url"] === undefined) continue;

    if (family === "meta") {
      const keys = group.keys
        .filter((key) => key["api-key"] !== "" && !key["api-key"].startsWith("dca:"))
        .map((key) => ({ ...key, "alpha-search": false }));

      if (keys.length === 0) continue;
      out.push({ ...group, "base-url": group["base-url"] ?? DEFAULT_META_BASE_URL, keys });
      continue;
    }

    if (family === "xai") {
      out.push({ ...group, keys: group.keys.map((key) => ({ ...key, "alpha-search": false })) });
      continue;
    }

    if (family === "gemini" || family === "interactions") {
      // Keys without credentials are meaningful only together with a base URL.
      const keys = group.keys.filter(
        (key) => key["api-key"] !== "" || group["base-url"] !== undefined,
      );

      if (keys.length === 0) continue;
      out.push({ ...group, keys });
      continue;
    }

    if (
      family === "opencode-zen" ||
      family === "opencode-go" ||
      family === "typesafe" ||
      family === "subq"
    ) {
      // Deviation (no Go counterpart): an OpenCode or System One key without a secret cannot authenticate; the base
      // URL defaults per provider when the credential is synthesised.
      const keys = group.keys.filter((key) => key["api-key"] !== "");

      if (keys.length === 0) continue;
      out.push({ ...group, keys });
      continue;
    }

    if (family === "vertex") {
      const keys = group.keys.filter((key) => key["api-key"] !== "");

      if (keys.length === 0) continue;
      out.push({
        ...group,
        ...modelsWithAliasAndName(group.models),
        keys: keys.map(withVertexModels),
      });
      continue;
    }

    out.push(group);
  }

  return out;
};

const normalizeCompat = (groups: readonly OpenAICompatGroup[]): OpenAICompatGroup[] => {
  const out: OpenAICompatGroup[] = [];

  for (const group of groups) {
    const baseUrl = group["base-url"].trim();

    if (baseUrl === "") continue;
    out.push(
      compact<OpenAICompatGroup>({
        ...group,
        name: group.name.trim(),
        "base-url": baseUrl,
        prefix: group.prefix === undefined ? undefined : normalizeModelPrefix(group.prefix),
        headers: normalizeHeaders(group.headers),
        models: withoutProtocol(group.models),
        "request-scoped-errors": normalizeScopedErrors(group["request-scoped-errors"]),
      }),
    );
  }

  return out;
};

const lowerKey = (key: string): string => key.trim().toLowerCase();

const normalizeAliases = (input: Readonly<Record<string, readonly OAuthModelAlias[]>>) => {
  const out: Record<string, OAuthModelAlias[]> = {};

  for (const [rawChannel, aliases] of Object.entries(input)) {
    const channel = lowerKey(rawChannel);

    if (channel === "") continue;
    const seen = new Set<string>();
    const clean: OAuthModelAlias[] = [];

    for (const entry of aliases) {
      const name = entry.name.trim();
      const alias = entry.alias.trim();

      if (name === "" || alias === "" || name.toLowerCase() === alias.toLowerCase()) continue;

      if (seen.has(alias.toLowerCase())) continue;
      seen.add(alias.toLowerCase());
      clean.push(
        compact<OAuthModelAlias>({
          name,
          alias,
          fork: entry.fork,
          "display-name": trimmedOrUndefined(entry["display-name"]),
          "force-mapping": entry["force-mapping"],
        }),
      );
    }

    if (clean.length > 0) out[channel] = clean;
  }

  return out;
};

/** Dedupes by `lower(name)->lower(alias)`, keeping the last occurrence in its original relative order. */
const normalizeSettings = (input: Readonly<Record<string, readonly OAuthModelSetting[]>>) => {
  const out: Record<string, OAuthModelSetting[]> = {};

  for (const [rawChannel, settings] of Object.entries(input)) {
    const channel = lowerKey(rawChannel);

    if (channel === "") continue;
    const seen = new Set<string>();
    const reversed: OAuthModelSetting[] = [];

    for (const entry of settings.toReversed()) {
      const name = entry.name.trim();

      if (name === "") continue;
      const alias = (entry.alias ?? "").trim();
      const key = `${name.toLowerCase()}->${alias.toLowerCase()}`;

      if (seen.has(key)) continue;
      seen.add(key);
      reversed.push(
        compact<OAuthModelSetting>({
          name,
          alias,
          "max-context-length": entry["max-context-length"],
        }),
      );
    }

    if (reversed.length > 0) out[channel] = reversed.toReversed();
  }

  return out;
};

const normalizeExcludedMap = (input: Readonly<Record<string, readonly string[]>>) => {
  const out: Record<string, string[]> = {};

  for (const [provider, models] of Object.entries(input)) {
    const key = lowerKey(provider);
    const normalized = normalizeExcludedModels(models);

    if (key !== "" && normalized !== undefined) out[key] = normalized;
  }

  return out;
};

const normalizeScopedErrorMap = (
  input: Readonly<Record<string, readonly RequestScopedErrorRule[]>>,
) => {
  const out: Record<string, RequestScopedErrorRule[]> = {};

  for (const [channel, rules] of Object.entries(input)) {
    const key = lowerKey(channel);
    const clean = normalizeScopedErrors(rules) ?? [];

    if (key !== "" && clean.length > 0) out[key] = clean;
  }

  return out;
};

/** Drops raw rules whose params are not valid JSON text (config_validation.go SanitizePayloadRules). */
const sanitizeRawRules = (rules: readonly PayloadRule[]): PayloadRule[] =>
  rules.filter((rule) => {
    const params = Object.entries(rule.params ?? {});

    if (params.length === 0) return false;

    return params.every(
      ([, value]) =>
        typeof value !== "string" ||
        (value.trim() !== "" && tryParseJson(value.trim()) !== undefined),
    );
  });

const trimValues = <T extends Record<string, unknown>>(value: T): T =>
  // SAFETY: only string values are replaced (by their trimmed form), so every property keeps its type in T.
  Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]),
  ) as T;

export const normalizeConfig = (config: Config): Config => {
  const usage = config.observability.usage;
  const retention = usage["redis-usage-queue-retention-seconds"];
  const providerKeys = config["api-keys"];
  const payload = config.requests.payload;

  return {
    ...config,
    access: {
      "api-keys": config.access["api-keys"].map((key) => key.trim()).filter((key) => key !== ""),
      "admin-emails": config.access["admin-emails"]
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email !== ""),
      "admin-service-tokens": config.access["admin-service-tokens"]
        .map((id) => id.trim())
        .filter((id) => id !== ""),
    },
    routing: {
      ...config.routing,
      retry: {
        ...config.routing.retry,
        "max-retry-credentials": Math.max(0, config.routing.retry["max-retry-credentials"]),
      },
    },
    requests: {
      ...config.requests,
      payload: {
        ...payload,
        "default-raw": sanitizeRawRules(payload["default-raw"]),
        "override-raw": sanitizeRawRules(payload["override-raw"]),
      },
    },
    upstream: {
      ...config.upstream,
      claude: {
        ...config.upstream.claude,
        "header-defaults": {
          ...config.upstream.claude["header-defaults"],
          ...trimValues({
            "user-agent": config.upstream.claude["header-defaults"]["user-agent"],
            "package-version": config.upstream.claude["header-defaults"]["package-version"],
            "runtime-version": config.upstream.claude["header-defaults"]["runtime-version"],
            os: config.upstream.claude["header-defaults"].os,
            arch: config.upstream.claude["header-defaults"].arch,
            timeout: config.upstream.claude["header-defaults"].timeout,
            timezone: config.upstream.claude["header-defaults"].timezone,
          }),
        },
      },
    },
    "api-keys": {
      gemini: dedupeAcrossGroups(normalizeFamily("gemini", providerKeys.gemini), IDENTITY.gemini),
      interactions: dedupeAcrossGroups(
        normalizeFamily("interactions", providerKeys.interactions),
        IDENTITY.interactions,
      ),
      vertex: dedupeAcrossGroups(normalizeFamily("vertex", providerKeys.vertex), IDENTITY.vertex),
      codex: normalizeFamily("codex", providerKeys.codex),
      claude: normalizeFamily("claude", providerKeys.claude),
      xai: normalizeFamily("xai", providerKeys.xai),
      meta: normalizeFamily("meta", providerKeys.meta),
      "opencode-zen": normalizeFamily("opencode-zen", providerKeys["opencode-zen"]),
      "opencode-go": normalizeFamily("opencode-go", providerKeys["opencode-go"]),
      typesafe: normalizeFamily("typesafe", providerKeys.typesafe),
      subq: normalizeFamily("subq", providerKeys.subq),
      "openai-compatibility": normalizeCompat(providerKeys["openai-compatibility"]),
    },
    oauth: {
      ...config.oauth,
      "model-alias": normalizeAliases(config.oauth["model-alias"]),
      settings: normalizeSettings(config.oauth.settings),
      "excluded-models": normalizeExcludedMap(config.oauth["excluded-models"]),
      "request-scoped-errors": normalizeScopedErrorMap(config.oauth["request-scoped-errors"]),
      providers: {
        ...config.oauth.providers,
        codex: {
          "header-defaults": trimValues({ ...config.oauth.providers.codex["header-defaults"] }),
        },
      },
    },
    multimedia: {
      ...config.multimedia,
      "gpt-image-2-base-model": config.multimedia["gpt-image-2-base-model"].trim(),
    },
    observability: {
      ...config.observability,
      usage: {
        ...usage,
        "redis-usage-queue-retention-seconds": retention <= 0 ? 60 : Math.min(retention, 3600),
      },
    },
  };
};
