/**
 * The admin view of the model registry: per client-visible model id, every credential that could serve it and why it
 * does or does not right now (`GET /v9/management/routing/models`). No Go counterpart: the Go panel only lists ids.
 *
 * Pure over a `RegistrySnapshot`. Two assemblies per credential (`assembleCredentialModels`): the *served* list (what
 * the registry holds: disabled credentials contribute nothing, exclusions applied) and the *potential* list (same
 * credential enabled and without exclusions). Every potential model is a route; a route missing from the served list
 * is `excluded` (or `disabled` when the credential is off). Everything else gets its state from the credential's
 * runtime state the way `projectModel` reads it (`availability.ts`). `listed` and `providers` come from the index, so
 * they agree with `/v1/models`.
 *
 * Exclusion patterns match the id of the credential's base list (the catalog id, or the alias of a config-defined
 * model) before aliasing and prefixing, so a route is matched on its upstream name, its id and its unprefixed id.
 */
import type { Types } from "effect";
import type { OAuthModelAlias } from "../config/schema.ts";
import { canonicalModelKey, matchWildcard } from "../credentials/selection/model-name.ts";
import type {
  ModelRoute,
  OAuthModelAliasWire,
  RoutedModel,
  RouteState,
  RoutingModels,
  RuleScope,
} from "@commissary/contract/routing";
import type { AuthIndexer } from "../management/auth-index.ts";
import { cooldownReason } from "./availability.ts";
import { compareStrings } from "./compare.ts";
import {
  assembleCredentialModels,
  type AssemblyOptions,
  oauthModelAliasChannel,
} from "./credential-models.ts";
import type { ModelInfo } from "./model-info.ts";
import type { RegistrySnapshot } from "./service.ts";
import type { ModelSource } from "./source.ts";

const iso = (ms: number): string => new Date(ms).toISOString();

const lower = (value: string): string => value.trim().toLowerCase();

type Runtime = Pick<ModelRoute, "state" | "reason" | "until">;

const runtime = (state: RouteState, until?: number, reason = ""): Runtime => {
  const out: Types.Mutable<Runtime> = { state };

  if (until !== undefined && until > 0) out.until = iso(until);

  if (reason !== "") out.reason = reason;

  return out;
};

/** State of one credential/model pair that is registered and not excluded, from the credential's runtime state. */
const runtimeState = (source: ModelSource, model: ModelInfo, now: number): Runtime => {
  const { state } = source;

  if (source.disabled || state.status === "disabled") return runtime("disabled");

  // Credential-wide quota (`credential_quota`) blocks every model until it recovers.
  if (
    state.quota.exceeded &&
    state.quota.reason === "credential_quota" &&
    state.quota.nextRecoverAt > now
  ) {
    return runtime(
      "quota",
      state.quota.nextRecoverAt,
      cooldownReason(state.statusMessage, state.quota, state.lastError),
    );
  }

  const keys = [canonicalModelKey(model.id)];

  if (model.metadataModelId !== undefined && model.metadataModelId !== "")
    keys.push(canonicalModelKey(model.metadataModelId));
  const modelState = keys.map((key) => state.modelStates[key]).find((entry) => entry !== undefined);

  if (modelState !== undefined) {
    const reason = cooldownReason(modelState.statusMessage, modelState.quota, modelState.lastError);
    const { quota } = modelState;

    if (quota.exceeded && (quota.nextRecoverAt === 0 || quota.nextRecoverAt > now))
      return runtime("quota", quota.nextRecoverAt > now ? quota.nextRecoverAt : undefined, reason);

    if (modelState.nextRetryAfter > now)
      return runtime("cooling", modelState.nextRetryAfter, reason);

    if (modelState.unavailable || modelState.status === "disabled")
      return runtime("unavailable", undefined, reason);

    return runtime("available");
  }

  if (
    Object.keys(state.modelStates).length === 0 &&
    state.unavailable &&
    state.nextRetryAfter > now
  ) {
    return runtime(
      "cooling",
      state.nextRetryAfter,
      cooldownReason(state.statusMessage, state.quota, state.lastError),
    );
  }

  return runtime("available");
};

interface Context {
  readonly snapshot: RegistrySnapshot;
  readonly options: AssemblyOptions;
  readonly authIndex: AuthIndexer;
}

/** The alias/exclusion channel of a credential; empty for provider keys and OpenAI-compatible groups. */
const channelOf = (source: ModelSource): string =>
  source.compat || source.source === "config"
    ? ""
    : oauthModelAliasChannel(source.provider, source.authKind);

/** First exclusion pattern matching the route, and where it lives. */
const matchedExclusion = (
  context: Context,
  source: ModelSource,
  model: ModelInfo,
  prefix: string,
): { readonly pattern: string; readonly scope: RuleScope } | undefined => {
  const candidates = new Set<string>();

  if (model.metadataModelId !== undefined && model.metadataModelId !== "")
    candidates.add(lower(model.metadataModelId));
  candidates.add(lower(model.id));

  if (prefix !== "" && model.id.startsWith(`${prefix}/`))
    candidates.add(lower(model.id.slice(prefix.length + 1)));

  const global = new Set(
    (context.snapshot.config.oauth["excluded-models"][lower(source.provider)] ?? []).map(lower),
  );

  for (const raw of source.excludedModels) {
    const pattern = lower(raw);

    if (pattern === "") continue;

    if ([...candidates].some((candidate) => matchWildcard(pattern, candidate))) {
      const scope: RuleScope = global.has(pattern)
        ? "channel"
        : source.source === "config"
          ? "key"
          : "account";

      return { pattern, scope };
    }
  }

  return undefined;
};

/** Where the alias that produced `id` is defined: the account's own list wins over the channel list. */
const aliasScope = (
  context: Context,
  source: ModelSource,
  channel: string,
  id: string,
): RuleScope | undefined => {
  if (channel === "") return undefined;

  const key = lower(id);

  const has = (list: ReadonlyArray<OAuthModelAlias>): boolean =>
    list.some((entry) => lower(entry.alias) === key);

  if (has(source.modelAliases)) return "account";

  return has(context.snapshot.config.oauth["model-alias"][channel] ?? []) ? "channel" : undefined;
};

/** Where a route's id comes from: the key's configured list, an alias rule, a write-in, else the catalog. */
const originOf = (configured: boolean, aliased: boolean, model: ModelInfo): ModelRoute["via"] => {
  if (configured) return "config";

  if (aliased) return "alias";

  return model.writeIn === true ? "write-in" : "catalog";
};

const routesOf = (context: Context, source: ModelSource, now: number) => {
  const { options } = context;
  const served = assembleCredentialModels(source, options)?.models ?? [];
  const servedIds = new Set(served.map((model) => model.id));

  const potential =
    assembleCredentialModels({ ...source, disabled: false, excludedModels: [] }, options)?.models ??
    [];

  const channel = channelOf(source);
  const prefix = (source.prefix ?? "").trim();
  const configured = source.compat || (source.models ?? []).length > 0;
  const seen = new Set<string>();
  const out: Array<{ readonly model: ModelInfo; readonly route: ModelRoute }> = [];

  for (const model of potential) {
    // A compat group may repeat an id (a model pool): one route per credential and id.
    if (seen.has(model.id)) continue;
    seen.add(model.id);

    const upstream =
      model.metadataModelId !== undefined && model.metadataModelId !== ""
        ? model.metadataModelId
        : model.id;

    const prefixed = prefix !== "" && model.id.startsWith(`${prefix}/`);
    const bare = prefixed ? model.id.slice(prefix.length + 1) : model.id;
    const via = originOf(configured, lower(bare) !== lower(upstream), model);
    let current: Runtime;
    let ruleScope: RuleScope | undefined;

    if (source.disabled || source.state.status === "disabled") {
      current = runtime("disabled");
    } else if (!servedIds.has(model.id)) {
      const match = matchedExclusion(context, source, model, prefix);
      current = runtime("excluded", undefined, match?.pattern);
      ruleScope = match?.scope;
    } else {
      current = runtimeState(source, model, now);
    }

    if (ruleScope === undefined && via === "alias")
      ruleScope = aliasScope(context, source, channel, bare);

    const route: Types.Mutable<ModelRoute> = {
      auth_index: context.authIndex(source.id),
      source: source.source,
      provider: source.provider,
      label: source.label,
      upstream,
      via,
      ...current,
    };

    if (channel !== "") route.channel = channel;

    if (source.source === "file") route.name = source.id;

    if (prefixed) route.prefix = prefix;

    if (ruleScope !== undefined) route.rule_scope = ruleScope;
    out.push({ model, route });
  }

  return out;
};

const aliasWire = (entry: OAuthModelAlias): OAuthModelAliasWire => {
  const out: Types.Mutable<OAuthModelAliasWire> = { name: entry.name, alias: entry.alias };

  if (entry.fork !== undefined) out.fork = entry.fork;

  if (entry["display-name"] !== undefined) out["display-name"] = entry["display-name"];

  if (entry["force-mapping"] !== undefined) out["force-mapping"] = entry["force-mapping"];

  return out;
};

/**
 * The routing view of `snapshot` at `now` (epoch ms). Routes carry the keyed `auth_index` (`authIndex`, the
 * deployment's indexer) and, for auth files only, the file name: config credential ids are never sent.
 */
export const routingView = (
  snapshot: RegistrySnapshot,
  now: number,
  authIndex: AuthIndexer,
): Omit<RoutingModels, "revisions"> => {
  const { config } = snapshot;

  const context: Context = {
    snapshot,
    authIndex,
    options: {
      config,
      catalogs: snapshot.catalogs,
      nowSeconds: Math.floor(now / 1000),
      // A member's view: the models their grants do not reach are not routes they can see.
      grants: snapshot.grantFilter,
    },
  };

  const grouped = new Map<string, { info: ModelInfo; routes: ModelRoute[] }>();
  const accounts = new Map<string, number>();

  for (const source of snapshot.sources) {
    const channel = channelOf(source);

    if (channel !== "") accounts.set(channel, (accounts.get(channel) ?? 0) + 1);

    for (const { model, route } of routesOf(context, source, now)) {
      const entry = grouped.get(model.id);

      if (entry === undefined) grouped.set(model.id, { info: model, routes: [route] });
      else {
        entry.info = model;
        entry.routes.push(route);
      }
    }
  }

  const listed = new Set(snapshot.index.availableModels(now).map((model) => model.id.trim()));

  const models: RoutedModel[] = [...grouped]
    .toSorted(([a], [b]) => compareStrings(a, b))
    .map(([id, { info: fallback, routes }]) => {
      // The registry's merged record when someone serves the id, else the last potential record.
      const info = snapshot.index.modelInfo(id, "") ?? fallback;
      const displayName = (info.displayName ?? "").trim();
      const contextLength = info.contextLength ?? 0;

      const model: Types.Mutable<RoutedModel> = {
        id,
        owned_by: info.ownedBy,
        type: info.type,
        listed: listed.has(id),
        providers: snapshot.index.providersForModel(id),
        routes,
      };

      if (displayName !== "") model.display_name = displayName;

      if (contextLength > 0) model.context_length = contextLength;

      return model;
    });

  return {
    observed_at: iso(now),
    config_version: snapshot.configVersion,
    force_model_prefix: config.routing["force-model-prefix"],
    channels: [...accounts]
      .toSorted(([a], [b]) => compareStrings(a, b))
      .map(([channel, count]) => ({ channel, accounts: count })),
    aliases: Object.fromEntries(
      Object.entries(config.oauth["model-alias"]).map(([channel, list]) => [
        channel,
        list.map(aliasWire),
      ]),
    ),
    excluded: Object.fromEntries(
      Object.entries(config.oauth["excluded-models"]).map(([channel, list]) => [
        channel,
        [...list],
      ]),
    ),
    write_ins: Object.fromEntries(
      Object.entries(config.models["write-ins"]).map(([provider, list]) => [
        provider,
        list.map((entry) => ({ ...entry })),
      ]),
    ),
    models,
  };
};
