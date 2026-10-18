/**
 * `GET /v9/management/provider-keys` (`@commissary/contract/provider-keys` `ProviderKeysList`): the config's `api-keys`
 * groups joined with the runtime state of the credentials they produced. Built inside the ControlPlane Durable Object
 * so the config version and the runtime state are one snapshot.
 *
 * Workers addition, no Go counterpart (Go's panel reads raw keys from `GET /config` and masks them in the browser;
 * here the browser never sees them, PRODUCT.md). Nothing secret is included: keys become `[redacted]…abcd`
 * previews, header values whose names look secret are masked, `proxy-url` and `experimental-cch-signing` are left
 * out (a warning says they exist), and error messages are scrubbed of the key and of token-shaped text. Keys and their
 * runtime are identified by the keyed `auth_index` only: the credential id (`claude:apikey:<sha256 prefix>`) is an
 * unsalted hash of the key and its settings, so it is never sent (nor the key's entry id, which is the credential id).
 * A group is identified by its entry id and carries its revision, which a write of the group names (ADR 0025).
 */
import type { ProviderKeyGroup, Config, OpenAICompatGroup } from "../config/schema.ts";
import { maskHeaders, maskSecret } from "../credentials/summary.ts";
import { redactSecrets } from "../credentials/redact.ts";
import type { RefreshTarget } from "../credentials/pool.ts";
import { DEFAULT_BASE_URL as CLAUDE_DEFAULT_BASE_URL } from "../executor/claude/credentials.ts";
import { CODEX_DEFAULT_BASE_URL } from "../executor/codex/headers.ts";
import { GEMINI_ENDPOINT, VERTEX_DEFAULT_BASE_URL } from "../executor/gemini/targets.ts";
import { META_DEFAULT_BASE_URL } from "../executor/meta/credentials.ts";
import { XAI_DEFAULT_API_BASE_URL } from "../executor/xai/credentials.ts";
import { OPENCODE_SPECS } from "../executor/opencode/providers.ts";
import { SUBQ, SYSTEM_ONE_PROVIDER_SPECS, TYPESAFE } from "../executor/systemone/providers.ts";
import type { JsonObject } from "@commissary/json";
import type { AuthIndexer } from "./auth-index.ts";
import { configKeyIds } from "../credentials/key-ids.ts";
import { cooldownSnapshot, recentRequestBuckets } from "./credential-entry.ts";
import type { ProviderKeyFamily } from "@commissary/contract/provider-keys";

/** Base URL a family talks to when the group sets none (what the executors use). */
export const DEFAULT_BASE_URLS: Readonly<
  Record<Exclude<ProviderKeyFamily, "openai-compatibility">, string>
> = {
  gemini: GEMINI_ENDPOINT,
  interactions: GEMINI_ENDPOINT,
  vertex: VERTEX_DEFAULT_BASE_URL,
  codex: CODEX_DEFAULT_BASE_URL,
  claude: CLAUDE_DEFAULT_BASE_URL,
  xai: XAI_DEFAULT_API_BASE_URL,
  meta: META_DEFAULT_BASE_URL,
  "opencode-zen": OPENCODE_SPECS["opencode-zen"].baseUrl,
  "opencode-go": OPENCODE_SPECS["opencode-go"].baseUrl,
  typesafe: SYSTEM_ONE_PROVIDER_SPECS[TYPESAFE].baseUrl,
  subq: SYSTEM_ONE_PROVIDER_SPECS[SUBQ].baseUrl,
};

/** Copy through JSON: drops `undefined` and detaches readonly config values from the plain wire shape. */
const plainObject = <T extends object>(value: T): JsonObject =>
  // SAFETY: only objects (config groups and keys without their secrets) are passed in, and JSON.parse of their
  // serialization is a JSON object.
  JSON.parse(JSON.stringify(value)) as JsonObject;

const keyPreview = (key: string): string => (key === "" ? "" : maskSecret(key));

const iso = (ms: number): string => new Date(ms).toISOString();

/** Runtime of one config credential; `secret` is scrubbed from the last error. */
const runtimeOf = (target: RefreshTarget, now: number, authIndex: AuthIndexer): JsonObject => {
  const { credential, state } = target;
  const cooldowns = cooldownSnapshot(state, now);
  const blocked = state.unavailable || cooldowns.length > 0;
  const nextRetry = state.nextRetryAfter > now ? state.nextRetryAfter : 0;
  const secret = credential.attributes.api_key ?? "";
  const error = state.lastError;

  const scrub = (message: string): string =>
    redactSecrets(secret === "" ? message : message.replaceAll(secret, "[redacted]"));

  const lastError: JsonObject | undefined =
    error === undefined
      ? undefined
      : {
          ...(error.code === undefined ? {} : { code: error.code }),
          ...(error.httpStatus === undefined ? {} : { http_status: error.httpStatus }),
          ...(error.message === "" ? {} : { message: scrub(error.message) }),
        };

  return {
    auth_index: authIndex(credential.id),
    status: credential.disabled
      ? "disabled"
      : blocked && state.status === "active"
        ? "error"
        : state.status,
    unavailable: blocked,
    success: state.success,
    failed: state.failed,
    recent_requests: recentRequestBuckets(state.recentRequests, now),
    cooldowns,
    ...(nextRetry > 0 ? { next_retry_after: iso(nextRetry) } : {}),
    ...(lastError === undefined ? {} : { last_error: lastError }),
  };
};

const isDisablingPattern = (pattern: string): boolean => pattern.trim() === "*";

const hasText = (value: string | undefined): boolean => (value ?? "").trim() !== "";

const proxyWarning =
  "proxy-url is set: outbound proxies do not exist on Workers, so it has no effect (kept in the config)";

const signingWarning = (count: number): string =>
  `experimental-cch-signing is set on ${count} key${count === 1 ? "" : "s"}: it has no effect on Workers (kept in the config)`;

interface Lookup {
  readonly ids: ReturnType<typeof configKeyIds>;
  /** Key group revisions by entry id. */
  readonly revisions: Readonly<Record<string, number>>;
  readonly runtime: ReadonlyMap<string, RefreshTarget>;
  readonly now: number;
  readonly authIndex: AuthIndexer;
}

const runtimeFor = (lookup: Lookup, id: string | undefined): JsonObject | null => {
  const target = id === undefined ? undefined : lookup.runtime.get(id);

  return target === undefined ? null : runtimeOf(target, lookup.now, lookup.authIndex);
};

/** A group's entry id and revision (every stored group has an id; the revision of one not stored is 0). */
const entryOf = (id: string | undefined, lookup: Lookup): JsonObject => ({
  id: id ?? "",
  revision:
    id !== undefined && Object.hasOwn(lookup.revisions, id) ? (lookup.revisions[id] ?? 0) : 0,
});

const groupView = (
  family: Exclude<ProviderKeyFamily, "openai-compatibility">,
  group: ProviderKeyGroup,
  index: number,
  lookup: Lookup,
): JsonObject => {
  const ids = lookup.ids[family][index]?.keys ?? [];
  const { id: groupId, keys, headers, "proxy-url": groupProxy, ...rest } = group;
  let signing = 0;
  let proxy = hasText(groupProxy);

  const keyViews = keys.map((entry, keyIndex): JsonObject => {
    const {
      id: _entryId,
      "api-key": providerKey,
      "proxy-url": keyProxy,
      "experimental-cch-signing": cch,
      headers: keyHeaders,
      ...visible
    } = entry;

    if (hasText(keyProxy)) proxy = true;

    if (cch !== undefined) signing += 1;
    const id = ids[keyIndex];
    const excluded = entry["excluded-models"] ?? group["excluded-models"] ?? [];

    return {
      ...(id === undefined ? {} : { auth_index: lookup.authIndex(id) }),
      key_preview: keyPreview(providerKey),
      disabled: excluded.some(isDisablingPattern),
      runtime: runtimeFor(lookup, id),
      ...plainObject(visible),
      ...(keyHeaders === undefined ? {} : { headers: maskHeaders(keyHeaders) }),
    };
  });

  return {
    ...entryOf(groupId, lookup),
    index,
    group: {
      ...plainObject(rest),
      ...(headers === undefined ? {} : { headers: maskHeaders(headers) }),
      keys: keyViews,
    },
    effective_base_url: (group["base-url"] ?? "").trim() || DEFAULT_BASE_URLS[family],
    warnings: [...(proxy ? [proxyWarning] : []), ...(signing > 0 ? [signingWarning(signing)] : [])],
  };
};

const compatGroupView = (group: OpenAICompatGroup, index: number, lookup: Lookup): JsonObject => {
  const ids = lookup.ids["openai-compatibility"][index]?.keys ?? [];
  const { id: groupId, keys, headers, ...rest } = group;
  const disabled = group.disabled === true;
  const proxy = keys.some((entry) => hasText(entry["proxy-url"]));

  const keyViews = keys.map((entry, keyIndex): JsonObject => ({
    ...(ids[keyIndex] === undefined ? {} : { auth_index: lookup.authIndex(ids[keyIndex]) }),
    key_preview: keyPreview(entry["api-key"]),
    disabled,
    runtime: runtimeFor(lookup, ids[keyIndex]),
    ...(entry.weight === undefined ? {} : { weight: entry.weight }),
  }));

  return {
    ...entryOf(groupId, lookup),
    index,
    group: {
      ...plainObject(rest),
      ...(headers === undefined ? {} : { headers: maskHeaders(headers) }),
      keys: keyViews,
    },
    effective_base_url: group["base-url"].trim(),
    warnings: proxy ? [proxyWarning] : [],
  };
};

/**
 * The `ProviderKeysList` of `config` (assembled at `version`, key group revisions `revisions`); `entries` are the pool's
 * credentials, of which only the config ones are used. `now` is epoch milliseconds; `authIndex` is the deployment's
 * indexer.
 */
export const buildProviderKeysList = (
  version: number,
  revisions: Readonly<Record<string, number>>,
  config: Pick<Config, "api-keys">,
  entries: ReadonlyArray<RefreshTarget>,
  now: number,
  authIndex: AuthIndexer,
): JsonObject => {
  const runtime = new Map<string, RefreshTarget>();

  for (const entry of entries)
    if (entry.credential.source === "config") runtime.set(entry.credential.id, entry);

  const lookup: Lookup = {
    ids: configKeyIds(config, { includeDisabledGroups: true }),
    revisions,
    runtime,
    now,
    authIndex,
  };

  const providerKeys = config["api-keys"];

  const standard = (family: Exclude<ProviderKeyFamily, "openai-compatibility">): JsonObject[] =>
    providerKeys[family].map((group, index) => groupView(family, group, index, lookup));

  return {
    version,
    families: {
      gemini: standard("gemini"),
      interactions: standard("interactions"),
      vertex: standard("vertex"),
      codex: standard("codex"),
      claude: standard("claude"),
      xai: standard("xai"),
      meta: standard("meta"),
      "opencode-zen": standard("opencode-zen"),
      "opencode-go": standard("opencode-go"),
      typesafe: standard("typesafe"),
      subq: standard("subq"),
      "openai-compatibility": providerKeys["openai-compatibility"].map((group, index) =>
        compatGroupView(group, index, lookup),
      ),
    },
  };
};
