/**
 * Raw document -> canonical v8 document.
 *
 * Go source: internal/config/config_v8.go (flattenV8/expandV8Groups/groupLegacyKeys, buildV8Paths, v8Aliases,
 * ValidateV8Config). Accepts the v8 layout as well as the legacy flat layout and historical v8 spellings. Rules
 * (same as Go): the v8 value wins when both spellings exist (by presence, even `false`/`0`), the legacy key is
 * removed, and `null` means "missing" everywhere except inside `requests.payload` where `null` is a real value.
 */
import {
  del,
  escapePathKey,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import { PROVIDER_KEY_FAMILIES } from "./schema.ts";
import { ConfigValidationError } from "./errors.ts";

type Move = readonly [from: string, to: string];

/**
 * The one v8 leaf under `oauth.providers.claude` (d0ee9ca7): the historical `oauth.providers.claude` -> `upstream.claude`
 * move leaves it in place.
 */
const CLAUDE_LOGIN_SCOPE = "oauth.providers.claude.oauth-include-create-api-key";

/** Historical v8 spellings (`v8ClientPaths`, `v8SharedPaths`, `v8SharedStructPaths`). */
const V8_ALIASES: readonly Move[] = [
  ["oauth.providers.codex.optimize-multi-agent-v2", "client.codex.optimize-multi-agent-v2"],
  ["providers.codex.optimize-multi-agent-v2", "client.codex.optimize-multi-agent-v2"],
  ["codex.optimize-multi-agent-v2", "client.codex.optimize-multi-agent-v2"],
  ["oauth.providers.codex.disable-codex-cloaking", "upstream.codex.disable-codex-cloaking"],
  ["oauth.providers.codex.stream-bootstrap-buffering", "upstream.codex.stream-bootstrap-buffering"],
  ["oauth.providers.codex.stream-bootstrap-timeout", "upstream.codex.stream-bootstrap-timeout"],
  [
    "oauth.providers.codex.orphan-delegation-compatibility",
    "upstream.codex.orphan-delegation-compatibility",
  ],
  ["oauth.providers.codex.model-level-cooling", "upstream.codex.model-level-cooling"],
  ["oauth.providers.codex.response-steering", "upstream.codex.response-steering"],
  [
    "oauth.providers.claude.claude-code.disable-cloaking-model-list",
    "upstream.claude.disable-cloaking-model-list",
  ],
  ["oauth.providers.claude", "upstream.claude"],
  ["oauth.providers.xai", "upstream.xai"],
];

/** Legacy flat layout -> v8 (`buildV8Paths`), restricted to the keys modelled by the Workers schema. */
const LEGACY_MOVES: readonly Move[] = [
  ["force-model-prefix", "routing.force-model-prefix"],
  ["request-retry", "routing.retry.request-retry"],
  ["max-retry-credentials", "routing.retry.max-retry-credentials"],
  ["max-retry-interval", "routing.retry.max-retry-interval"],
  ["disable-cooling", "routing.cooldown.disable-cooling"],
  ["save-cooldown-status", "routing.cooldown.save-cooldown-status"],
  ["transient-error-cooldown-seconds", "routing.cooldown.transient-error-cooldown-seconds"],
  ["proxy-url", "requests.proxy-url"],
  ["passthrough-headers", "requests.passthrough-headers"],
  ["nonstream-keepalive-interval", "requests.nonstream-keepalive-interval"],
  ["streaming", "requests.streaming"],
  ["payload", "requests.payload"],
  ["auth-auto-refresh-workers", "oauth.auth-auto-refresh-workers"],
  ["oauth-model-alias", "oauth.model-alias"],
  ["oauth-excluded-models", "oauth.excluded-models"],
  ["oauth-request-scoped-errors", "oauth.request-scoped-errors"],
  ["oauth-settings", "oauth.settings"],
  ["codex.disable-codex-cloaking", "upstream.codex.disable-codex-cloaking"],
  ["codex.stream-bootstrap-buffering", "upstream.codex.stream-bootstrap-buffering"],
  ["codex.stream-bootstrap-timeout", "upstream.codex.stream-bootstrap-timeout"],
  ["codex.orphan-delegation-compatibility", "upstream.codex.orphan-delegation-compatibility"],
  ["codex.model-level-cooling", "upstream.codex.model-level-cooling"],
  ["codex.response-steering", "upstream.codex.response-steering"],
  ["codex-header-defaults", "oauth.providers.codex.header-defaults"],
  ["claude.oauth-include-create-api-key", CLAUDE_LOGIN_SCOPE],
  ["claude", "upstream.claude"],
  ["claude-code", "upstream.claude"],
  ["disable-claude-cloak-mode", "upstream.claude.disable-claude-cloak-mode"],
  ["claude-header-defaults", "upstream.claude.header-defaults"],
  ["antigravity", "oauth.providers.antigravity"],
  ["antigravity-signature-cache-enabled", "oauth.providers.antigravity.signature-cache-enabled"],
  ["antigravity-signature-bypass-strict", "oauth.providers.antigravity.signature-bypass-strict"],
  ["quota-exceeded.antigravity-credits", "oauth.providers.antigravity.antigravity-credits"],
  ["xai", "upstream.xai"],
  ["devin", "oauth.providers.devin"],
  ["disable-image-generation", "multimedia.disable-image-generation"],
  ["gpt-image-2-base-model", "multimedia.gpt-image-2-base-model"],
  ["video-result-auth-cache-ttl", "multimedia.video-result-auth-cache-ttl"],
  ["debug", "observability.logs.debug"],
  ["request-log", "observability.logs.request-log"],
  ["usage-statistics-enabled", "observability.usage.usage-statistics-enabled"],
  [
    "redis-usage-queue-retention-seconds",
    "observability.usage.redis-usage-queue-retention-seconds",
  ],
];

/** Legacy `*-api-key` lists -> `api-keys.<family>` (`v8KeyFamilies`). */
const LEGACY_FAMILIES: ReadonlyArray<readonly [legacy: string, family: string]> = [
  ["gemini-api-key", "gemini"],
  ["interactions-api-key", "interactions"],
  ["vertex-api-key", "vertex"],
  ["codex-api-key", "codex"],
  ["claude-api-key", "claude"],
  ["xai-api-key", "xai"],
  ["meta-api-key", "meta"],
  ["openai-compatibility", "openai-compatibility"],
];

/** Group-level fields besides `name`, `base-url` and `keys` (`sharedKeyFields`). */
const SHARED_KEY_FIELDS = [
  "priority",
  "prefix",
  "proxy-url",
  "headers",
  "models",
  "excluded-models",
  "disable-cooling",
  "request-retry",
  "request-scoped-errors",
] as const;

const ROUTING_STRATEGY_ALIASES = new Map<string, string>([
  ["round-robin", "round-robin"],
  ["roundrobin", "round-robin"],
  ["rr", "round-robin"],
  ["weighted-round-robin", "weighted-round-robin"],
  ["weightedroundrobin", "weighted-round-robin"],
  ["wrr", "weighted-round-robin"],
  ["fill-first", "fill-first"],
  ["fillfirst", "fill-first"],
  ["ff", "fill-first"],
]);

/** Moves `from` to `to`; an existing target wins, object values merge key by key. */
const moveMerge = (doc: JsonObject, from: string, to: string): void => {
  const value = get(doc, from);

  if (value === undefined) return;
  const target = get(doc, to);

  if (target === undefined) {
    set(doc, to, value);
  } else if (isJsonObject(value) && isJsonObject(target)) {
    for (const key of Object.keys(value)) {
      const escaped = escapePathKey(key);
      moveMerge(doc, `${from}.${escaped}`, `${to}.${escaped}`);
    }
  }

  del(doc, from);
};

/** `groupLegacyKeys`: one group per legacy entry, auto-named `<family>-<index+1>`. */
const groupLegacyKeys = (entries: readonly Json[], family: string): Json[] =>
  entries.map((entry, index) => {
    if (!isJsonObject(entry)) return entry;

    if (family === "openai-compatibility") {
      const { "api-key-entries": keys, ...group } = entry;

      return { ...group, keys: keys ?? [] };
    }

    const group: JsonObject = { name: `${family}-${index + 1}` };
    const key: JsonObject = {};

    for (const [field, value] of Object.entries(entry)) {
      if (field === "base-url" || SHARED_KEY_FIELDS.some((shared) => shared === field))
        group[field] = value;
      else key[field] = value;
    }

    group.keys = [key];

    return group;
  });

/** Removes `null` values (YAML `key:` without value) except inside `requests.payload`. */
const stripNulls = (value: Json, path: string): Json | undefined => {
  if (value === null)
    return path === "requests.payload" || path.startsWith("requests.payload.") ? null : undefined;

  if (isJsonArray(value)) {
    // Null items are only kept inside payload rules (handled by the null check above).
    return value.flatMap((item) => {
      const stripped = stripNulls(item, `${path}[]`);

      return stripped === undefined ? [] : [stripped];
    });
  }

  if (isJsonObject(value)) {
    const out: JsonObject = {};

    for (const [key, child] of Object.entries(value)) {
      const stripped = stripNulls(child, path === "" ? key : `${path}.${key}`);

      if (stripped !== undefined)
        Object.defineProperty(out, key, {
          value: stripped,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }

    return out;
  }

  return value;
};

/** Lenient parsing of `disable-image-generation` strings (`on`, `yes`, `Chat`, ...). */
const normalizeDisableImageGeneration = (value: Json | undefined): Json | undefined => {
  if (typeof value !== "string") return value;

  switch (value.trim().toLowerCase()) {
    case "":
    case "false":
    case "0":
    case "off":
    case "no":
      return false;
    case "true":
    case "1":
    case "on":
    case "yes":
      return true;
    case "chat":
      return "chat";
    case "passthrough":
      return "passthrough";
    default:
      throw new ConfigValidationError({
        message:
          "invalid multimedia.disable-image-generation value (allowed: true, false, chat, passthrough)",
        path: "multimedia.disable-image-generation",
      });
  }
};

const validateProviderKeys = (providerKeys: Json | undefined): void => {
  if (providerKeys === undefined) return;

  if (!isJsonObject(providerKeys))
    throw new ConfigValidationError({ message: "api-keys must be a mapping of provider groups" });
  const allowed = new Set<string>(PROVIDER_KEY_FAMILIES);

  for (const [family, groups] of Object.entries(providerKeys)) {
    if (!allowed.has(family))
      throw new ConfigValidationError({ message: `api-keys.${family}: unknown provider` });

    if (!isJsonArray(groups))
      throw new ConfigValidationError({ message: `api-keys.${family} must be a list` });

    for (const [index, group] of groups.entries()) {
      const where = `api-keys.${family}[${index}]`;

      if (!isJsonObject(group))
        throw new ConfigValidationError({ message: `${where} must be a mapping` });

      if (!isJsonArray(group.keys))
        throw new ConfigValidationError({ message: `${where}.keys must be a list` });

      for (const key of group.keys) {
        if (!isJsonObject(key))
          throw new ConfigValidationError({ message: `${where}: key must be a mapping` });
        delete key.auth_index;
        delete key["auth-index"];

        // Go accepts credential-less entries (e.g. a gemini entry with only a base URL).
        if (family !== "openai-compatibility" && key["api-key"] === undefined) key["api-key"] = "";

        if (family !== "openai-compatibility" && key["base-url"] !== undefined) {
          throw new ConfigValidationError({
            message: `api-keys.${family}: base-url belongs to the group`,
          });
        }
      }

      delete group.auth_index;
      delete group["auth-index"];

      if (family !== "openai-compatibility") {
        // `id`: the group's config entry id (ADR 0025), set on the documents the ControlPlane assembles.
        const groupFields = new Set<string>([
          "id",
          "name",
          "base-url",
          "keys",
          ...SHARED_KEY_FIELDS,
        ]);

        for (const field of Object.keys(group)) {
          if (!groupFields.has(field)) {
            throw new ConfigValidationError({
              message: `api-keys.${family}: unsupported group field ${field}`,
            });
          }
        }
      }
    }
  }
};

/**
 * Converts any supported raw document (parsed YAML or JSON) into the canonical v8 shape expected by the schema.
 * The input is not modified. Throws {@link ConfigValidationError}.
 */
export const prepareDocument = (raw: Json): JsonObject => {
  if (!isJsonObject(raw)) throw new ConfigValidationError({ message: "config must be a mapping" });
  const doc = structuredClone(raw);

  const version = doc["config-version"];

  if (version !== undefined && version !== null && version !== 8) {
    throw new ConfigValidationError({ message: "unsupported config-version (expected 8)" });
  }

  // Legacy `api-keys` is the client key list; v8 `api-keys` is the provider map.
  if (isJsonArray(doc["api-keys"])) {
    const clientKeys = doc["api-keys"];
    delete doc["api-keys"];

    if (get(doc, "access.api-keys") === undefined) set(doc, "access.api-keys", clientKeys);
  }

  const loginScope = get(doc, CLAUDE_LOGIN_SCOPE);

  if (loginScope !== undefined) del(doc, CLAUDE_LOGIN_SCOPE);

  for (const [from, to] of [...V8_ALIASES, ...LEGACY_MOVES]) moveMerge(doc, from, to);

  if (loginScope !== undefined) set(doc, CLAUDE_LOGIN_SCOPE, loginScope);

  for (const [legacy, family] of LEGACY_FAMILIES) {
    const entries = doc[legacy];

    if (!isJsonArray(entries)) continue;
    delete doc[legacy];
    const providerKeys = isJsonObject(doc["api-keys"]) ? doc["api-keys"] : {};
    doc["api-keys"] = providerKeys;

    if (providerKeys[family] === undefined) providerKeys[family] = groupLegacyKeys(entries, family);
  }

  validateProviderKeys(doc["api-keys"]);

  const stripped = stripNulls(doc, "");
  const out = isJsonObject(stripped) ? stripped : {};

  const strategy = get(out, "routing.strategy");

  if (typeof strategy === "string") {
    const canonical = ROUTING_STRATEGY_ALIASES.get(strategy.trim().toLowerCase());
    // Like Go, an unrecognised strategy falls back to round-robin.
    set(out, "routing.strategy", canonical ?? "round-robin");
  }

  const disable = normalizeDisableImageGeneration(get(out, "multimedia.disable-image-generation"));

  if (disable !== undefined) set(out, "multimedia.disable-image-generation", disable);

  return out;
};
