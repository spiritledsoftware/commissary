/**
 * The `api-keys` config groups as the panel's provider keys page sees them
 * (`packages/models/src/management/provider-keys-routes.ts`), plus the schemas of those groups themselves: `config/schema.ts`
 * re-exports the group schemas from here, so there is one definition. Shared with the browser: imports `effect` and
 * sibling contract modules only.
 *
 * Secrets never leave the server (PRODUCT.md): a key is shown as `key_preview` (`[redacted]…abcd`), secret-looking
 * header values are masked, and the settings that do nothing on Workers (`proxy-url`, `experimental-cch-signing`)
 * are not shown at all (`warnings` says they exist). Writes are lossless: a key is addressed by `auth_index`, which
 * keeps its stored secret and hidden settings, or carries a new `api-key`; a header value that is still the
 * `[redacted]…` placeholder keeps the stored value.
 *
 * Every group is a config entry (ADR 0025) with an `id` and a `revision`, and each of its keys an entry whose id is
 * its credential id (never sent). A write names the group by `id` (none for a new group) and the `revision` of the
 * list it was made from; a group changed or deleted since is answered `409 conflict` (writes to other groups never
 * conflict), an unknown `auth_index` `409 unknown_auth_index`, and a group the config normaliser would (partly) drop
 * `422` with the reason as the error text. A key kept by `auth_index` keeps its credential id and `auth_index`, also
 * when the write gives it a new secret.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Revision } from "./config.ts";
import { Cooldown, CredentialStatus, RecentRequests } from "./credentials.ts";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

const Strings = Schema.Array(Schema.String);

const StringMap = Schema.Record(Schema.String, Schema.String);

/** Credential weight (internal/credentialweight): any integer, but at most 1,000,000. */
export const Weight = Schema.Int.check(Schema.isLessThanOrEqualTo(1_000_000));

// --- config group schemas (moved from config/schema.ts) ------------------------------------------------------------

export const RequestScopedErrorRule = Schema.Struct({
  status: optional(Schema.Int),
  match: optional(Strings),
  "match-regexr": optional(Strings),
  /** `stop`, `stop-and-cooldown`, `continue` or `continue-and-cooldown`. */
  action: optional(Schema.String),
});

export type RequestScopedErrorRule = typeof RequestScopedErrorRule.Type;

export const ThinkingSupport = Schema.Struct({
  min: optional(Schema.Int),
  max: optional(Schema.Int),
  "zero-allowed": optional(Schema.Boolean),
  "dynamic-allowed": optional(Schema.Boolean),
  levels: optional(Strings),
});

export type ThinkingSupport = typeof ThinkingSupport.Type;

/**
 * Upstream protocols of the OpenCode gateways (`/chat/completions`, `/responses`, `/messages`, Gemini native, and
 * `/systemone` for System One models, ADR 0032).
 */
export const OPENCODE_PROTOCOLS = ["chat", "responses", "messages", "gemini", "systemone"] as const;

export const OpenCodeProtocol = Schema.Literals(OPENCODE_PROTOCOLS);

export type OpenCodeProtocol = typeof OpenCodeProtocol.Type;

export const isOpenCodeProtocol = (value: string | undefined): value is OpenCodeProtocol =>
  OPENCODE_PROTOCOLS.some((protocol) => protocol === value);

/** Model entry of a provider-key group (the union of the per-provider Go model structs). */
export const ModelEntry = Schema.Struct({
  /** Upstream model name. */
  name: Schema.String,
  /** Client-visible alias. */
  alias: optional(Schema.String),
  "display-name": optional(Schema.String),
  "max-context-length": optional(Schema.Int),
  "force-mapping": optional(Schema.Boolean),
  "is-compat": optional(Schema.Boolean),
  thinking: optional(ThinkingSupport),
  /** Codex only. */
  "support-configuration-update": optional(Schema.Boolean),
  /** OpenAI-compatibility only. */
  image: optional(Schema.Boolean),
  "input-modalities": optional(Strings),
  "output-modalities": optional(Strings),
  "use-max-completion-tokens": optional(Schema.Boolean),
  /**
   * OpenCode Zen/Go only: the upstream protocol (`OPENCODE_PROTOCOLS`), overriding the model catalog. Decoded as any
   * string so a stray value on another provider never breaks the document: the normaliser drops it there, and
   * `decodeRawConfig` rejects an unknown value in the OpenCode sections.
   */
  protocol: optional(Schema.String),
});

export type ModelEntry = typeof ModelEntry.Type;

export const CloakConfig = Schema.Struct({
  mode: optional(Schema.String),
  "strict-mode": optional(Schema.Boolean),
  "sensitive-words": optional(Strings),
  "cache-user-id": optional(Schema.Boolean),
});

export type CloakConfig = typeof CloakConfig.Type;

/** Settings shared by a group and (as overrides) by its keys. A missing key inherits the group value. */
const sharedKeyFields = {
  priority: optional(Schema.Int),
  prefix: optional(Schema.String),
  /** No effect on Workers (no outbound proxies), but part of the credential identity: never shown, always kept. */
  "proxy-url": optional(Schema.String),
  headers: optional(StringMap),
  models: optional(Schema.Array(ModelEntry)),
  "excluded-models": optional(Strings),
  "disable-cooling": optional(Schema.Boolean),
  "request-retry": optional(Schema.Int),
  "request-scoped-errors": optional(Schema.Array(RequestScopedErrorRule)),
};

/** Every key setting except the secret itself. */
const keyFields = {
  weight: optional(Weight),
  ...sharedKeyFields,
  /** Claude. */
  "rebuild-mid-system-message": optional(Schema.Boolean),
  cloak: optional(CloakConfig),
  "fingerprint-profile": optional(Schema.String),
  /** No effect on Workers: never shown, always kept. */
  "experimental-cch-signing": optional(Schema.Boolean),
  /** Codex / xAI / Meta. */
  websockets: optional(Schema.Boolean),
  "alpha-search": optional(Schema.Boolean),
  "disable-codex-cloaking": optional(Schema.Boolean),
  /** Vertex. */
  interactions: optional(Schema.Boolean),
};

/**
 * The config entry id of a key group or provider key (ADR 0025), set by the ControlPlane when the entry is stored. A
 * provider key's id is its credential id, so it never leaves the Worker; a group's id is random and names the group in writes.
 * A Go config document never sets it: the import drops ids and assigns its own.
 */
const entryId = { id: optional(Schema.String) };

/** One credential inside a provider-key group. */
export const ProviderKeyEntry = Schema.Struct({
  ...entryId,
  "api-key": Schema.String,
  ...keyFields,
});

export type ProviderKeyEntry = typeof ProviderKeyEntry.Type;

const groupFields = {
  name: optional(Schema.String),
  "base-url": optional(Schema.String),
  ...sharedKeyFields,
};

/** `api-keys.<provider>[]` group: one endpoint, shared settings and a list of keys. */
export const ProviderKeyGroup = Schema.Struct({
  ...entryId,
  ...groupFields,
  keys: Schema.Array(ProviderKeyEntry),
});

export type ProviderKeyGroup = typeof ProviderKeyGroup.Type;

const compatKeyFields = {
  weight: optional(Weight),
  "proxy-url": optional(Schema.String),
};

export const OpenAICompatKey = Schema.Struct({
  ...entryId,
  "api-key": Schema.String,
  ...compatKeyFields,
});

const compatGroupFields = {
  name: Schema.String,
  priority: optional(Schema.Int),
  disabled: optional(Schema.Boolean),
  prefix: optional(Schema.String),
  "base-url": Schema.String,
  headers: optional(StringMap),
  models: optional(Schema.Array(ModelEntry)),
  "support-prompt-cache-key": optional(Schema.Boolean),
  "disable-cooling": optional(Schema.Boolean),
  "request-retry": optional(Schema.Int),
  "request-scoped-errors": optional(Schema.Array(RequestScopedErrorRule)),
};

/** `api-keys.openai-compatibility[]` group. */
export const OpenAICompatGroup = Schema.Struct({
  ...entryId,
  ...compatGroupFields,
  keys: Schema.Array(OpenAICompatKey),
});

export type OpenAICompatGroup = typeof OpenAICompatGroup.Type;

/** The v8 provider family names that may appear under `api-keys`. */
export const PROVIDER_KEY_FAMILIES = [
  "gemini",
  "interactions",
  "vertex",
  "codex",
  "claude",
  "xai",
  "meta",
  "opencode-zen",
  "opencode-go",
  "typesafe",
  "subq",
  "openai-compatibility",
] as const;

export const ProviderKeyFamily = Schema.Literals(PROVIDER_KEY_FAMILIES);

export type ProviderKeyFamily = typeof ProviderKeyFamily.Type;

/** The families whose groups are `ProviderKeyGroup` (all but the OpenAI-compatible endpoints). */
export const KeyGroupFamily = Schema.Literals([
  "gemini",
  "interactions",
  "vertex",
  "codex",
  "claude",
  "xai",
  "meta",
  "opencode-zen",
  "opencode-go",
  "typesafe",
  "subq",
]);

export type KeyGroupFamily = typeof KeyGroupFamily.Type;

// --- the list the page reads -------------------------------------------------------------------------------------

/** What a header value looks like once masked; writing it back keeps the stored value. */
export const REDACTED_PREFIX = "[redacted]";

/** Runtime state of the credential a key produced (counters, cooldowns, last error). */
export const KeyRuntime = Schema.Struct({
  /**
   * The key's keyed `auth_index`: what `PATCH /credentials/status` and the usage filters take. The credential id is not
   * sent (it is an unsalted hash of the key).
   */
  auth_index: Schema.String,
  status: CredentialStatus,
  unavailable: Schema.Boolean,
  success: Schema.Number,
  failed: Schema.Number,
  recent_requests: Schema.Array(RecentRequests),
  cooldowns: Schema.Array(Cooldown),
  next_retry_after: optional(Schema.String),
  last_error: optional(
    Schema.Struct({
      code: optional(Schema.String),
      http_status: optional(Schema.Int),
      message: optional(Schema.String),
    }),
  ),
});

export type KeyRuntime = typeof KeyRuntime.Type;

const {
  "proxy-url": _groupProxy,
  "experimental-cch-signing": _signing,
  ...visibleKeyFields
} = keyFields;

const { "proxy-url": _sharedProxy, ...visibleSharedFields } = sharedKeyFields;

/** A key as the page sees it: no `api-key`, hidden settings left out. */
export const ProviderKeyView = Schema.Struct({
  /** Absent when the key produced no credential (an empty key without a base URL). */
  auth_index: optional(Schema.String),
  /** `[redacted]…abcd`, or empty for a key-less entry. */
  key_preview: Schema.String,
  /** The key's effective `excluded-models` contains `*`. */
  disabled: Schema.Boolean,
  /** `null` when the key produced no credential. */
  runtime: Schema.NullOr(KeyRuntime),
  ...visibleKeyFields,
});

export type ProviderKeyView = typeof ProviderKeyView.Type;

export const ProviderKeyGroupBody = Schema.Struct({
  name: optional(Schema.String),
  "base-url": optional(Schema.String),
  ...visibleSharedFields,
  keys: Schema.Array(ProviderKeyView),
});

export type ProviderKeyGroupBody = typeof ProviderKeyGroupBody.Type;

/** One group of a key family. `effective_base_url` is the configured base URL or the provider's default. */
export const GroupView = Schema.Struct({
  /** The group's entry id: what a write or delete names. */
  id: Schema.String,
  /** The group's revision: a write or delete sends it back. */
  revision: Schema.Int,
  /** Position in the family. */
  index: Schema.Int,
  group: ProviderKeyGroupBody,
  effective_base_url: Schema.String,
  /** Settings that do nothing on Workers and were kept (their values are never shown). */
  warnings: Schema.Array(Schema.String),
});

export type GroupView = typeof GroupView.Type;

const { "proxy-url": _compatProxy, ...visibleCompatKeyFields } = compatKeyFields;

/** An OpenAI-compatible key: only the secret, weight and (hidden) proxy exist. */
export const CompatKeyView = Schema.Struct({
  auth_index: optional(Schema.String),
  key_preview: Schema.String,
  /** The endpoint is disabled (compat keys cannot be disabled one by one). */
  disabled: Schema.Boolean,
  runtime: Schema.NullOr(KeyRuntime),
  ...visibleCompatKeyFields,
});

export type CompatKeyView = typeof CompatKeyView.Type;

export const CompatGroupBody = Schema.Struct({
  ...compatGroupFields,
  keys: Schema.Array(CompatKeyView),
});

export type CompatGroupBody = typeof CompatGroupBody.Type;

export const CompatGroupView = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  index: Schema.Int,
  group: CompatGroupBody,
  effective_base_url: Schema.String,
  warnings: Schema.Array(Schema.String),
});

export type CompatGroupView = typeof CompatGroupView.Type;

const GroupFamilies = Schema.Struct({
  gemini: Schema.Array(GroupView),
  interactions: Schema.Array(GroupView),
  vertex: Schema.Array(GroupView),
  codex: Schema.Array(GroupView),
  claude: Schema.Array(GroupView),
  xai: Schema.Array(GroupView),
  meta: Schema.Array(GroupView),
  "opencode-zen": Schema.Array(GroupView),
  "opencode-go": Schema.Array(GroupView),
  typesafe: Schema.Array(GroupView),
  subq: Schema.Array(GroupView),
  "openai-compatibility": Schema.Array(CompatGroupView),
});

/**
 * What an org admin sees of another member's private key group (ADR 0023): that it exists, its provider, owner and
 * label. The `id` and `revision` let an org admin remove it (`DELETE /provider-keys/groups` with `private`).
 */
export const LimitedKeyGroup = Schema.Struct({
  id: Schema.String,
  revision: Revision,
  family: ProviderKeyFamily,
  provider: Schema.String,
  label: Schema.String,
  limited: Schema.Literal(true),
  private: Schema.Literal(true),
  owner: Schema.Struct({ member_id: Schema.String, email: optional(Schema.String) }),
});

export type LimitedKeyGroup = typeof LimitedKeyGroup.Type;

/**
 * `GET /provider-keys`: every group, with its id and revision. `families` holds the org's shared groups (empty for a plain
 * member). `own` holds the caller's private groups in full (a member only), `others` lists the other members'
 * private groups for an org admin, existence only.
 */
export const ProviderKeysList = Schema.Struct({
  /** The org's change counter. */
  version: Schema.Int,
  families: GroupFamilies,
  own: optional(GroupFamilies),
  others: optional(Schema.Array(LimitedKeyGroup)),
});

export type ProviderKeysList = typeof ProviderKeysList.Type;

// --- writes ---------------------------------------------------------------------------------------------------------

/**
 * A key being written: `auth_index` keeps the stored key (its secret and hidden settings carry over), `api-key`
 * replaces or sets the secret (with `auth_index` it replaces that key's secret). One of the two is required.
 */
export const KeyInput = Schema.Struct({
  "api-key": optional(Schema.String),
  auth_index: optional(Schema.String),
  ...keyFields,
});

export type KeyInput = typeof KeyInput.Type;

export const GroupInput = Schema.Struct({
  ...groupFields,
  keys: Schema.Array(KeyInput),
});

export type GroupInput = typeof GroupInput.Type;

export const CompatKeyInput = Schema.Struct({
  "api-key": optional(Schema.String),
  auth_index: optional(Schema.String),
  ...compatKeyFields,
});

export type CompatKeyInput = typeof CompatKeyInput.Type;

export const CompatGroupInput = Schema.Struct({
  ...compatGroupFields,
  keys: Schema.Array(CompatKeyInput),
});

export type CompatGroupInput = typeof CompatGroupInput.Type;

/**
 * `PUT /provider-keys/groups`: replaces the group `id` at `revision`, or adds a group (no `id`, `revision` 0) after the
 * family's last one.
 */
export const PutGroupRequest = Schema.Union([
  Schema.Struct({
    family: KeyGroupFamily,
    id: optional(Schema.String),
    revision: Revision,
    /** The group is the caller's private group (always so for a plain member). */
    private: optional(Schema.Boolean),
    group: GroupInput,
  }),
  Schema.Struct({
    family: Schema.Literal("openai-compatibility"),
    id: optional(Schema.String),
    revision: Revision,
    private: optional(Schema.Boolean),
    group: CompatGroupInput,
  }),
]);

export type PutGroupRequest = typeof PutGroupRequest.Type;

export const DeleteGroupRequest = Schema.Struct({
  family: ProviderKeyFamily,
  id: Schema.String,
  revision: Revision,
  /** The group is a private one (the caller's own, or any member's for an org admin). */
  private: optional(Schema.Boolean),
});

export type DeleteGroupRequest = typeof DeleteGroupRequest.Type;

/** Answer of a group write: the new change counter and the group's id and new revision (0 once deleted). */
export const ProviderKeysWritten = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.Int,
  id: Schema.String,
  revision: Schema.Int,
});

export const ProbeRequest = Schema.Struct({ auth_index: Schema.String });

export const ProbeModel = Schema.Struct({
  id: Schema.String,
  display_name: optional(Schema.String),
});

/**
 * `POST /provider-keys/probe`: one request to the key's configured base host (a model list, or a token count for Vertex).
 * `error` is a fixed message plus the upstream status: response bodies and keys are never copied.
 */
export const ProbeResult = Schema.Struct({
  ok: Schema.Boolean,
  status_code: optional(Schema.Int),
  latency_ms: Schema.Number,
  error: optional(Schema.String),
  models: optional(Schema.Array(ProbeModel)),
});

export type ProbeResult = typeof ProbeResult.Type;

export class ProviderKeysGroup extends HttpApiGroup.make("providerKeys").add(
  HttpApiEndpoint.get("list", "/provider-keys", {
    success: ProviderKeysList,
    error: managementErrors,
  }),
  HttpApiEndpoint.put("putGroup", "/provider-keys/groups", {
    payload: PutGroupRequest,
    success: ProviderKeysWritten,
    error: managementErrors,
  }),
  HttpApiEndpoint.delete("deleteGroup", "/provider-keys/groups", {
    payload: DeleteGroupRequest,
    success: ProviderKeysWritten,
    error: managementErrors,
  }),
  HttpApiEndpoint.post("probe", "/provider-keys/probe", {
    payload: ProbeRequest,
    success: ProbeResult,
    error: managementErrors,
  }),
) {}
