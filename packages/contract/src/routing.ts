/**
 * `GET /v9/management/routing/models` (`packages/models/src/management/routing-models.ts`,
 * `packages/models/src/registry/routing-view.ts`) and the channel rule edits of the Models page (`PUT|DELETE
 * /model-rules/aliases/:channel`, `/model-rules/exclusions/:channel`, `/model-rules/write-ins/:channel`, served by
 * `packages/models/src/management/model-rules-routes.ts`). Shared with the browser: imports `effect` only.
 *
 * `routing/models` answers, per client-visible model id, every credential that could serve it and why it does or does
 * not right now. It is built from a fresh (uncached) registry snapshot, so an edit shows on the next read. The same
 * body carries the three rule maps and their `revisions`: each channel's aliases, exclusions and write-ins are a config entry
 * (ADR 0025), and a rule edit sends the entry's revision back as `If-Match` (0 for a channel without rules). The write
 * is refused with 409 `conflict` when that entry changed since (lists are replaced whole, so a stale view would
 * otherwise lose another tab's edit); edits of other channels never conflict. The new revision comes back in
 * `EntrySaved.revision`.
 *
 * Concepts. A *channel* is the credential's provider key as stored (lower-case auth-file `type`, e.g. `claude`,
 * `kimi.com`): the key of `oauth.model-alias` and `oauth.excluded-models`; provider keys and OpenAI-compatible groups have
 * none. A *route* is one credential's way to one model id. `upstream` is the name the provider sees (the id before
 * aliasing and prefixing). A *write-in* (`models.write-ins`, keyed like a channel) adds a model the catalog does not
 * list yet to every credential of the provider whose models come from the catalog, accounts and provider keys alike.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { EntrySaved, Revisions } from "./config.ts";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/**
 * What one credential does for one model right now: `available`; `cooling` (retry timer, `until`); `quota`
 * (exceeded, `until` when the recovery time is known); `unavailable` (blocked without a timer, e.g. model disabled
 * upstream); `disabled` (the credential is switched off); `excluded` (an exclusion rule removes the model for this
 * credential, `reason` = the matching pattern).
 */
export const RouteState = Schema.Literals([
  "available",
  "cooling",
  "quota",
  "unavailable",
  "disabled",
  "excluded",
]);

export type RouteState = typeof RouteState.Type;

/**
 * Where a model comes from: the provider catalog, the credential's configured `models` list, an alias rule, or a
 * write-in (a model the org added to the provider's catalog until the catalog lists it).
 */
export const RouteOrigin = Schema.Literals(["catalog", "config", "alias", "write-in"]);

export type RouteOrigin = typeof RouteOrigin.Type;

/** Which rule list a `rule_scope` points at: the channel's global list, one account's file, one provider key (group). */
export const RuleScope = Schema.Literals(["channel", "account", "key"]);

export type RuleScope = typeof RuleScope.Type;

export const ModelRoute = Schema.Struct({
  /** Credential handle (`credentials.list` entries carry the same value). */
  auth_index: Schema.String,
  source: Schema.Literals(["file", "config"]),
  /** Credential provider as stored; equals `channel` for accounts. */
  provider: Schema.String,
  /** Alias/exclusion channel; absent for provider keys and OpenAI-compatible groups. */
  channel: optional(Schema.String),
  /** Account email, compat group name or `<family>-apikey`. */
  label: Schema.String,
  /** Auth-file name (file credentials only): the account page address. */
  name: optional(Schema.String),
  /** Upstream model name (before aliasing and prefixing). */
  upstream: Schema.String,
  via: RouteOrigin,
  /** Set when the client-visible id is `<prefix>/<model>`. */
  prefix: optional(Schema.String),
  state: RouteState,
  /** Cooldown reason, or the exclusion pattern that matched (`state: "excluded"`). */
  reason: optional(Schema.String),
  /** Excluded rows: where the matching pattern lives. Alias rows: where the alias rule lives. */
  rule_scope: optional(RuleScope),
  /** ISO time the cooldown or quota block ends (`cooling`, `quota`). */
  until: optional(Schema.String),
});

export type ModelRoute = typeof ModelRoute.Type;

export const RoutedModel = Schema.Struct({
  /** The id clients send. */
  id: Schema.String,
  display_name: optional(Schema.String),
  owned_by: Schema.String,
  type: Schema.String,
  /** Whether `/v1/models` lists it right now. */
  listed: Schema.Boolean,
  /** Registry providers (executor keys) with a serving credential, most registrations first. */
  providers: Schema.Array(Schema.String),
  context_length: optional(Schema.Number),
  routes: Schema.Array(ModelRoute),
});

export type RoutedModel = typeof RoutedModel.Type;

/** One `oauth.model-alias` entry (the config's wire keys). */
export const OAuthModelAliasWire = Schema.Struct({
  /** Upstream model name. */
  name: Schema.String,
  /** The id clients call instead. */
  alias: Schema.String,
  /** Keep the original id next to the alias. */
  fork: optional(Schema.Boolean),
  "display-name": optional(Schema.String),
  "force-mapping": optional(Schema.Boolean),
});

export type OAuthModelAliasWire = typeof OAuthModelAliasWire.Type;

/**
 * One `models.write-ins` entry: a model the org adds to a provider's catalog until the catalog lists it (then the
 * catalog's record wins and the write-in has no effect).
 */
export const ModelWriteIn = Schema.Struct({
  /** The model id the provider receives, and clients call. */
  name: Schema.String,
  /**
   * A catalog model of the same provider whose limits, modalities, thinking settings and price the write-in takes.
   * Without it the model is user-defined: thinking settings pass through unchecked, and it has no catalog price.
   */
  like: optional(Schema.String),
  "display-name": optional(Schema.String),
});

export type ModelWriteIn = typeof ModelWriteIn.Type;

export const RoutingChannel = Schema.Struct({
  channel: Schema.String,
  /** Credentials (enabled or not) using the channel. */
  accounts: Schema.Number,
});

export const RoutingModels = Schema.Struct({
  observed_at: Schema.String,
  /** Config version (the org's change counter) this view was built from. */
  config_version: Schema.Number,
  /** Revision of each channel's rules by channel (absent: 0); send it as `If-Match` on that channel's rule edits. */
  revisions: Schema.Struct({ aliases: Revisions, exclusions: Revisions, write_ins: Revisions }),
  /** `routing.force-model-prefix`: prefixed credentials serve only `<prefix>/<model>`. */
  force_model_prefix: Schema.Boolean,
  /** Channels with at least one credential, by name. */
  channels: Schema.Array(RoutingChannel),
  /** `oauth.model-alias`: channel to aliases. */
  aliases: Schema.Record(Schema.String, Schema.Array(OAuthModelAliasWire)),
  /** `oauth.excluded-models`: channel to patterns (`*` wildcards, matched on the upstream name). */
  excluded: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  /** `models.write-ins`: provider key to the models written in for it. */
  write_ins: Schema.Record(Schema.String, Schema.Array(ModelWriteIn)),
  /** Every model any credential could serve, sorted by id. */
  models: Schema.Array(RoutedModel),
});

export type RoutingModels = typeof RoutingModels.Type;

/** The `If-Match` request header: the channel revision the edit was based on (a bare number or `"<number>"`). */
const IfMatch = { headers: Schema.Struct({ "if-match": Schema.String }) };

const channelParam = { params: { channel: Schema.String } };

export class RoutingGroup extends HttpApiGroup.make("routing").add(
  HttpApiEndpoint.get("models", "/routing/models", {
    success: RoutingModels,
    error: managementErrors,
  }),
  /** Replace one channel's aliases. */
  HttpApiEndpoint.put("putAliases", "/model-rules/aliases/:channel", {
    ...channelParam,
    ...IfMatch,
    payload: Schema.Array(OAuthModelAliasWire),
    success: EntrySaved,
    error: managementErrors,
  }),
  /** Remove one channel's aliases (404 when it has none). */
  HttpApiEndpoint.delete("deleteAliases", "/model-rules/aliases/:channel", {
    ...channelParam,
    ...IfMatch,
    success: EntrySaved,
    error: managementErrors,
  }),
  /** Replace one channel's exclusion patterns. */
  HttpApiEndpoint.put("putExclusions", "/model-rules/exclusions/:channel", {
    ...channelParam,
    ...IfMatch,
    payload: Schema.Array(Schema.String),
    success: EntrySaved,
    error: managementErrors,
  }),
  /** Remove one channel's exclusion patterns (404 when it has none). */
  HttpApiEndpoint.delete("deleteExclusions", "/model-rules/exclusions/:channel", {
    ...channelParam,
    ...IfMatch,
    success: EntrySaved,
    error: managementErrors,
  }),
  /** Replace one provider's write-ins. */
  HttpApiEndpoint.put("putWriteIns", "/model-rules/write-ins/:channel", {
    ...channelParam,
    ...IfMatch,
    payload: Schema.Array(ModelWriteIn),
    success: EntrySaved,
    error: managementErrors,
  }),
  /** Remove one provider's write-ins (404 when it has none). */
  HttpApiEndpoint.delete("deleteWriteIns", "/model-rules/write-ins/:channel", {
    ...channelParam,
    ...IfMatch,
    success: EntrySaved,
    error: managementErrors,
  }),
) {}
