/**
 * `GET|PATCH /v9/management/settings` (`packages/models/src/management/settings-routes.ts`,
 * `packages/models/src/management/settings.ts`): the Settings page's typed view of the config settings that apply on Workers,
 * and its writes; `POST /settings/import`: the Go config import. Shared with the browser: imports `effect` and sibling
 * contract modules only.
 *
 * Values keep the config's kebab-case spelling and nesting, so a patch maps 1:1 to config paths. The view never
 * carries a secret (PRODUCT.md): provider keys have their own page.
 *
 * Every setting is a config entry of its own (ADR 0025), named by its dotted path (`routing.strategy`). The view's
 * `revisions` holds the revision of every stored setting; a setting at its default is not stored (revision 0). A save
 * is `{revisions, patch}`: `patch` is a deep partial of {@link SettingsValues} where `null` resets a leaf to its
 * default, and `revisions` names the revision of every setting the patch changes (absent = 0). Answers: the new
 * `version` and the new revision of each changed setting; `409 conflict` when one of them changed since (re-read the
 * setting and re-apply; a save of other settings never conflicts); `400 not_a_setting` for a path that is not a
 * setting; `422 invalid_setting` with `message` and `path` for a value the config would not keep as sent (invalid
 * duration, unknown catalog source, a value the normaliser rewrites, ...). Who manages the org is not a setting: the
 * Members page (`members.ts`, ADR 0022).
 *
 * The import takes a Go config document as the request body (YAML or JSON, v8 or legacy layout, at most 512 KiB) and
 * replaces every config entry of the org with it in one transaction. It answers the new `version` and `not_applied`:
 * the keys that have no effect on Workers, which are not stored (MIGRATION.md). `422 invalid_config` with `message`
 * (and `path`, `line`, `column` when known) for a document the config refuses. A key whose secret a stored
 * key of its family has keeps that key's id, and so its `auth_index`.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { RequestScopedErrorRule } from "./provider-keys.ts";
import { ConfigVersion, Revisions } from "./config.ts";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

const Strings = Schema.Array(Schema.String);

/** `routing.strategy` (the aliases `wrr`, `ff`, ... are normalised when a document is imported). */
export const RoutingStrategy = Schema.Literals([
  "round-robin",
  "weighted-round-robin",
  "fill-first",
]);

export type RoutingStrategy = typeof RoutingStrategy.Type;

/** `multimedia.disable-image-generation`: `false`, `true`, `"chat"` or `"passthrough"`. */
export const DisableImageGeneration = Schema.Union([
  Schema.Boolean,
  Schema.Literals(["chat", "passthrough"]),
]);

export type DisableImageGeneration = typeof DisableImageGeneration.Type;

/**
 * `upstream.claude.cloak-level`: how much of a cloaked Claude request is made to look like Claude Code. `full` sends
 * everything Claude Code sends; `minimal` only what a Claude subscription checks (GLOSSARY.md, "Cloak level").
 */
export const ClaudeCloakLevel = Schema.Literals(["full", "minimal"]);

export type ClaudeCloakLevel = typeof ClaudeCloakLevel.Type;

/** A Go duration (`30m`, `1h30m`); validated by the server. */
const GoDuration = Schema.String;

/** A Go `*bool`: `null` = not set (the setting's documented default applies). */
const Tristate = Schema.NullOr(Schema.Boolean);

/** Nested sections whose leaves are schemas: one definition for the values and the patch. */
interface SettingsTree {
  readonly [key: string]: Schema.Top | SettingsTree;
}

/**
 * Every Settings-owned config key. Sections are plain objects, leaves are schemas. Not here: `api-keys` (Keys page),
 * `oauth.model-alias` / `excluded-models` (Models › Rules), `oauth.settings`, `requests.payload` and
 * `oauth.request-scoped-errors` (set by the config import; the view summarises the last two), and the keys that do
 * nothing on Workers.
 */
export const SETTINGS_TREE = {
  routing: {
    strategy: RoutingStrategy,
    "session-affinity": Schema.Boolean,
    "session-affinity-ttl": GoDuration,
    "session-affinity-subagents": Schema.Boolean,
    "force-model-prefix": Schema.Boolean,
    retry: {
      "request-retry": Schema.Int,
      /** 0 = every credential. */
      "max-retry-credentials": Schema.Int,
      /** Seconds; the Worker waits at most 30 s and answers `Retry-After` beyond that. */
      "max-retry-interval": Schema.Int,
    },
    cooldown: {
      "disable-cooling": Schema.Boolean,
      /** 0 = 60 s, negative disables. */
      "transient-error-cooldown-seconds": Schema.Int,
    },
  },
  requests: {
    "passthrough-headers": Schema.Boolean,
    "nonstream-keepalive-interval": Schema.Int,
    streaming: {
      /** Server-sent events only (no WebSocket pings on Workers). */
      "keepalive-seconds": Schema.Int,
      "bootstrap-retries": Schema.Int,
    },
  },
  upstream: {
    codex: {
      "response-steering": Schema.Boolean,
      "disable-codex-cloaking": Schema.Boolean,
      "stream-bootstrap-buffering": Schema.Boolean,
      /** Go duration or whole seconds; `0`, `none`, `unlimited`, `off`, ... = unlimited. */
      "stream-bootstrap-timeout": Schema.String,
      "orphan-delegation-compatibility": Schema.Boolean,
      "model-level-cooling": Schema.Boolean,
    },
    claude: {
      "model-level-cooling": Schema.Boolean,
      "disable-claude-cloak-mode": Schema.Boolean,
      "cloak-level": ClaudeCloakLevel,
      "disable-cloaking-model-list": Schema.Boolean,
      "header-defaults": {
        "user-agent": Schema.String,
        "package-version": Schema.String,
        "runtime-version": Schema.String,
        os: Schema.String,
        arch: Schema.String,
        timeout: Schema.String,
        /** IANA time zone, `Local` or empty (UTC). */
        timezone: Schema.String,
        "stabilize-device-profile": Tristate,
      },
    },
    xai: { "inject-x-search": Schema.Boolean },
  },
  client: {
    codex: {
      "enable-apply-patch": Schema.Boolean,
      "optimize-multi-agent-v2": Schema.Boolean,
    },
  },
  oauth: {
    /** Token refresh concurrency per run; 0 = 16. */
    "auth-auto-refresh-workers": Schema.Int,
    providers: {
      codex: {
        "header-defaults": { "user-agent": Schema.String, "beta-features": Schema.String },
      },
      antigravity: {
        "sensitive-words": Strings,
        "antigravity-credits": Schema.Boolean,
        /** `null` = on. */
        "signature-cache-enabled": Tristate,
        /** `null` = off. */
        "signature-bypass-strict": Tristate,
      },
      devin: { "sensitive-words": Strings },
    },
  },
  multimedia: {
    "disable-image-generation": DisableImageGeneration,
    /** Empty = `gpt-5.4-mini`; must start with `gpt-`. */
    "gpt-image-2-base-model": Schema.String,
    "video-result-auth-cache-ttl": GoDuration,
  },
  models: {
    /** The models.dev catalog source: `""` official (`https://models.dev/api.json`), `embed`, `disabled` or an http(s) URL. */
    catalog: Schema.String,
  },
} as const satisfies SettingsTree;

type ValuesFields<T extends SettingsTree> = {
  readonly [K in keyof T]: T[K] extends infer Leaf extends Schema.Top
    ? Leaf
    : T[K] extends infer Section extends SettingsTree
      ? Schema.Struct<ValuesFields<Section>>
      : never;
};

type PatchFields<T extends SettingsTree> = {
  readonly [K in keyof T]: T[K] extends infer Leaf extends Schema.Top
    ? Schema.optionalKey<Schema.NullOr<Leaf>>
    : T[K] extends infer Section extends SettingsTree
      ? Schema.optionalKey<Schema.Struct<PatchFields<Section>>>
      : never;
};

const mapTree = (
  tree: SettingsTree,
  leaf: (schema: Schema.Top) => Schema.Top,
  section: (fields: Schema.Struct.Fields) => Schema.Top,
): Schema.Struct.Fields =>
  Object.fromEntries(
    Object.entries(tree).map(([key, node]) => [
      key,
      Schema.isSchema(node) ? leaf(node) : section(mapTree(node, leaf, section)),
    ]),
  );

const valuesFields = <T extends SettingsTree>(tree: T): ValuesFields<T> =>
  // SAFETY: mapTree keeps every key of `tree`, leaves as they are and sections as structs: the shape of ValuesFields.
  mapTree(
    tree,
    (schema) => schema,
    (fields) => Schema.Struct(fields),
  ) as ValuesFields<T>;

const patchFields = <T extends SettingsTree>(tree: T): PatchFields<T> =>
  // SAFETY: mapTree keeps every key of `tree`, leaves as optional nullable and sections as optional structs.
  mapTree(
    tree,
    (schema) => optional(Schema.NullOr(schema)),
    (fields) => optional(Schema.Struct(fields)),
  ) as PatchFields<T>;

/** Every Settings-owned value, effective (defaults filled), in config spelling. */
export const SettingsValues = Schema.Struct(valuesFields(SETTINGS_TREE));

export type SettingsValues = typeof SettingsValues.Type;

/** Deep partial of {@link SettingsValues}; `null` resets a leaf to its default. */
export const SettingsPatch = Schema.Struct(patchFields(SETTINGS_TREE));

export type SettingsPatch = typeof SettingsPatch.Type;

export const PayloadCounts = Schema.Struct({
  default: Schema.Int,
  "default-raw": Schema.Int,
  override: Schema.Int,
  "override-raw": Schema.Int,
  filter: Schema.Int,
});

export const SettingsView = Schema.Struct({
  /** The org's change counter. */
  version: ConfigVersion,
  /** The revision of every stored setting by dotted path; a setting not listed is at its default (revision 0). */
  revisions: Revisions,
  /** ISO time of the last config write; absent when nothing was ever stored. */
  updated_at: optional(Schema.String),
  values: SettingsValues,
  /** The values of an empty config: "default" captions and Reset. */
  defaults: SettingsValues,
  /** `requests.payload` rule counts per kind (set by the config import). */
  payload: PayloadCounts,
  /** Accounts and provider keys with a model prefix (what `routing.force-model-prefix` acts on). */
  prefixed_credentials: Schema.Int,
  /** `oauth.request-scoped-errors`: per account provider, read-only here (set by the config import). */
  request_scoped_errors: Schema.Record(Schema.String, Schema.Array(RequestScopedErrorRule)),
});

export type SettingsView = typeof SettingsView.Type;

export const SaveSettings = Schema.Struct({ revisions: Revisions, patch: SettingsPatch });

export type SaveSettings = typeof SaveSettings.Type;

/** A saved patch: the new change counter and the new revision of every setting it changed (0: back to default). */
export const SettingsSaved = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.Int,
  revisions: Revisions,
});

export type SettingsSaved = typeof SettingsSaved.Type;

/** A Go config document (YAML or JSON) as the import's request body. */
export const ConfigDocument = Schema.String.pipe(
  HttpApiSchema.asText({ contentType: "application/yaml" }),
);

/** An imported config document: the new change counter and the keys that were not stored. */
export const ConfigImported = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.Int,
  /** Keys of the document that have no effect on Workers; they were not stored (MIGRATION.md). */
  not_applied: Strings,
});

export type ConfigImported = typeof ConfigImported.Type;

export class SettingsGroup extends HttpApiGroup.make("settings").add(
  HttpApiEndpoint.get("get", "/settings", { success: SettingsView, error: managementErrors }),
  HttpApiEndpoint.patch("save", "/settings", {
    payload: SaveSettings,
    success: SettingsSaved,
    error: managementErrors,
  }),
  HttpApiEndpoint.post("importConfig", "/settings/import", {
    payload: ConfigDocument,
    success: ConfigImported,
    error: managementErrors,
  }),
) {}
