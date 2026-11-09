// The Models page's model: each model's standing over its routes, the order and filters of the list, where a model
// comes from and why a route is off, the channel rules (aliases, exclusions and write-ins) with their live match counts, and
// rule edits as deltas that are re-applied to the latest config when another edit landed first (409). Pure apart
// from `saveRuleChange`, which runs a change against injected reads and writes; tested in test/models.test.ts.
import { Effect, type Types } from "effect";
import { ManagementError } from "@commissary/contract/errors";
import type {
  ModelRoute,
  ModelWriteIn,
  OAuthModelAliasWire,
  RoutedModel,
  RouteState,
  RoutingModels,
  RuleScope,
} from "@commissary/contract/routing";
import type { ProviderKeyFamily, ProviderKeysList } from "@commissary/contract/provider-keys";
import { cooldownReason } from "./accounts.ts";
import { FAMILY_ORDER, familyName, groupTitle, keyTail } from "./keys.ts";
import { providerName } from "./providers.ts";

const lower = (value: string): string => value.trim().toLowerCase();

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

const at = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Date.parse(raw);

  return Number.isNaN(parsed) ? undefined : parsed;
};

// ---------------------------------------------------------------------------------------------------------------
// A model and its routes

/** A route that could serve: not removed by an exclusion rule and not on a disabled account or key. */
export const isActive = (route: ModelRoute): boolean =>
  route.state !== "excluded" && route.state !== "disabled";

export type StateCounts = Readonly<Record<RouteState, number>>;

export const stateCounts = (model: RoutedModel): StateCounts => {
  const counts: Record<RouteState, number> = {
    available: 0,
    cooling: 0,
    quota: 0,
    unavailable: 0,
    disabled: 0,
    excluded: 0,
  };

  for (const route of model.routes) counts[route.state] += 1;

  return counts;
};

export interface ModelStanding {
  /**
   * `closed`: routes could serve but none takes requests (red); `partial`: some do; `ok`: all do; `inert`: every
   * route is excluded or disabled, a deliberate state (stone).
   */
  readonly tone: "ok" | "partial" | "closed" | "inert";
  readonly label: string;
  /** The routes that are not taking requests, counted by why: "1 resting", "2 excluded". */
  readonly details: ReadonlyArray<string>;
}

const STATE_WORDS: ReadonlyArray<readonly [RouteState, string]> = [
  ["cooling", "resting"],
  ["quota", "out of quota"],
  ["unavailable", "unavailable"],
  ["excluded", "excluded"],
  ["disabled", "disabled"],
];

export const modelStanding = (model: RoutedModel): ModelStanding => {
  const counts = stateCounts(model);
  const active = model.routes.filter(isActive).length;
  const total = model.routes.length;

  if (active === 0) {
    const label =
      counts.disabled === 0
        ? total === 1
          ? "Excluded"
          : "Excluded on every route"
        : counts.excluded === 0
          ? total === 1
            ? "Disabled"
            : "Disabled on every route"
          : "Excluded or disabled on every route";

    return { tone: "inert", label, details: [] };
  }

  const details = STATE_WORDS.flatMap(([state, word]) =>
    counts[state] === 0 ? [] : [`${counts[state]} ${word}`],
  );

  // Counted against every route, so "1 of 2 routes" agrees with a detail like "1 disabled".
  const some = `${counts.available} of ${plural(total, "route")} taking requests`;

  if (counts.available === active) {
    const every = total === 1 ? "Taking requests" : `All ${total} routes taking requests`;

    return { tone: "ok", label: active === total ? every : some, details };
  }

  if (counts.available === 0) {
    return {
      tone: "closed",
      label: total === 1 ? "Not taking requests" : "No route taking requests",
      details,
    };
  }

  return { tone: "partial", label: some, details };
};

/** A route that could serve is resting, out of quota or unavailable. Excluded and disabled routes are deliberate. */
export const needsAttention = (model: RoutedModel): boolean =>
  model.routes.some((route) => isActive(route) && route.state !== "available");

/** Not in `/v1/models` right now. */
export const isHidden = (model: RoutedModel): boolean => !model.listed;

const RANK: Readonly<Record<ModelStanding["tone"], number>> = {
  closed: 0,
  partial: 1,
  ok: 2,
  inert: 3,
};

/**
 * Problems first: models no route serves, then models with resting or out-of-quota routes, then healthy ones, then
 * the ones rules or disabled accounts take away; by id within each.
 */
export const sortModels = (models: ReadonlyArray<RoutedModel>): ReadonlyArray<RoutedModel> =>
  models.toSorted(
    (a, b) => RANK[modelStanding(a).tone] - RANK[modelStanding(b).tone] || compareIds(a.id, b.id),
  );

/** Whether the model, its upstream names or the accounts and keys serving it mention the search (lower-cased). */
export const modelMatches = (model: RoutedModel, query: string): boolean =>
  query === "" ||
  [
    model.id,
    model.display_name,
    ...model.routes.flatMap((route) => [route.upstream, route.label, providerName(route.provider)]),
  ].some((field) => field?.toLowerCase().includes(query) === true);

/** Provider names, those serving it first; a model nobody serves names the providers of its routes. */
export const modelProviders = (model: RoutedModel): ReadonlyArray<string> => [
  ...new Set(
    (model.providers.length > 0
      ? model.providers
      : model.routes.map((route) => route.provider)
    ).map(providerName),
  ),
];

/**
 * Where the id comes from: "Alias of claude-opus-4-5", "Key config", "Write-in", "Prefix team/"; else "Catalog".
 */
export const modelOrigins = (model: RoutedModel): ReadonlyArray<string> => {
  const aliases = new Set<string>();
  const prefixes = new Set<string>();
  let configured = false;
  let writtenIn = false;

  for (const route of model.routes) {
    if (route.via === "alias") aliases.add(`Alias of ${route.upstream}`);

    if (route.via === "config") configured = true;

    if (route.via === "write-in") writtenIn = true;

    if (route.prefix !== undefined) prefixes.add(`Prefix ${route.prefix}/`);
  }

  const origins = [
    ...aliases,
    ...(configured ? ["Key config"] : []),
    ...(writtenIn ? ["Write-in"] : []),
    ...prefixes,
  ];

  return origins.length === 0 ? ["Catalog"] : origins;
};

/** Where one route's id comes from, in the words of `modelOrigins`. */
export const routeOrigin = (route: ModelRoute): string => {
  switch (route.via) {
    case "alias":
      return `Alias of ${route.upstream}`;
    case "config":
      return "Key config";
    case "write-in":
      return "Write-in";
    case "catalog":
      return "Catalog";
  }
};

/**
 * The provider's name for a route when clients call the model by another id ("as claude-opus-4-5"): a prefix or an
 * endpoint's alias. An alias rule names it in its origin already.
 */
export const upstreamNote = (modelId: string, route: ModelRoute): string | undefined =>
  route.via === "alias" || route.upstream === modelId ? undefined : `as ${route.upstream}`;

// ---------------------------------------------------------------------------------------------------------------
// One route

export interface RouteStanding {
  /** `ok` taking requests, `closed` resting/out of quota/unavailable (red), `off` excluded or disabled (stone). */
  readonly tone: "ok" | "closed" | "off";
  readonly label: string;
  /** When a resting or out-of-quota route takes requests again (ms), while that is still ahead. */
  readonly backAt: number | undefined;
}

export const routeStanding = (route: ModelRoute, now: number): RouteStanding => {
  const until = at(route.until);
  const backAt = until !== undefined && until > now ? until : undefined;
  const reason = route.reason === undefined || route.reason === "" ? undefined : route.reason;

  switch (route.state) {
    case "available":
      return { tone: "ok", label: "Taking requests", backAt: undefined };
    case "cooling":
      return {
        tone: "closed",
        label: reason === undefined ? "Resting" : `Resting: ${cooldownReason(reason)}`,
        backAt,
      };
    case "quota":
      return {
        tone: "closed",
        label: reason === "credential_quota" ? "Account quota used up" : "Quota used up",
        backAt,
      };
    case "unavailable":
      return {
        tone: "closed",
        label: reason === undefined ? "Unavailable" : `Unavailable: ${cooldownReason(reason)}`,
        backAt: undefined,
      };
    case "disabled":
      return {
        tone: "off",
        label: route.source === "file" ? "Account disabled" : "Key disabled",
        backAt: undefined,
      };
    case "excluded":
      return { tone: "off", label: "Excluded", backAt: undefined };
  }
};

/** Where a provider key lives on the provider keys page. */
export interface KeyHome {
  readonly family: ProviderKeyFamily;
  readonly index: number;
  /** "Claude key …Qx7a", or the endpoint name of an OpenAI-compatible group. */
  readonly name: string;
  /** The group's title ("Personal"), or "OpenAI-compatible". */
  readonly group: string;
}

/** Every configured key by `auth_index`, so a route names the key it uses and links to its group. */
export const keyHomes = (list: ProviderKeysList): ReadonlyMap<string, KeyHome> => {
  const homes = new Map<string, KeyHome>();

  for (const family of FAMILY_ORDER) {
    for (const view of list.families[family]) {
      const title = groupTitle(family, view);

      for (const key of view.group.keys) {
        if (key.auth_index === undefined) continue;
        const tail = keyTail(key.key_preview);
        const compat = family === "openai-compatibility";

        homes.set(key.auth_index, {
          family,
          index: view.index,
          name: compat ? title : `${familyName(family)} key${tail === "" ? "" : ` ${tail}`}`,
          group: compat ? "OpenAI-compatible" : title,
        });
      }
    }
  }

  return homes;
};

/** Who serves a route: its name, a second line, and where it is managed. */
export interface RouteWho {
  readonly name: string;
  readonly detail: string | undefined;
  readonly home:
    | { readonly kind: "account"; readonly authIndex: string }
    | { readonly kind: "key"; readonly family: ProviderKeyFamily; readonly index: number }
    | { readonly kind: "keys" };
}

export const routeWho = (route: ModelRoute, homes: ReadonlyMap<string, KeyHome>): RouteWho => {
  if (route.source === "file") {
    return {
      name: route.label === "" ? (route.name ?? "Account") : route.label,
      detail: providerName(route.provider),
      home: { kind: "account", authIndex: route.auth_index },
    };
  }

  const home = homes.get(route.auth_index);

  if (home !== undefined) {
    return {
      name: home.name,
      detail: home.group,
      home: { kind: "key", family: home.family, index: home.index },
    };
  }

  // `openai-compatible-<name>`, or `openai-compatibility` for a group without a name.
  const compat = route.provider.startsWith("openai-compatib");

  return {
    name: compat ? route.label : `${providerName(route.provider)} provider key`,
    detail: compat ? "OpenAI-compatible" : undefined,
    home: { kind: "keys" },
  };
};

/** Why a route is excluded or carries an alias, and where that rule lives. */
export interface Provenance {
  readonly kind: "excluded" | "alias";
  readonly scope: RuleScope | undefined;
  /** The exclusion pattern that matched. */
  readonly pattern: string | undefined;
  /** The channel whose rule it is (`scope: "channel"`). */
  readonly channel: string | undefined;
}

export const routeProvenance = (route: ModelRoute): Provenance | undefined => {
  if (route.state === "excluded") {
    return {
      kind: "excluded",
      scope: route.rule_scope,
      pattern: route.reason === "" ? undefined : route.reason,
      channel: route.channel,
    };
  }

  if (route.via === "alias" && route.rule_scope !== undefined) {
    return { kind: "alias", scope: route.rule_scope, pattern: undefined, channel: route.channel };
  }

  return undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// Channel rules

export interface ChannelRules {
  readonly channel: string;
  /** Accounts on the channel (enabled or not). */
  readonly accounts: number;
  readonly aliases: ReadonlyArray<OAuthModelAliasWire>;
  readonly excluded: ReadonlyArray<string>;
  readonly writeIns: ReadonlyArray<ModelWriteIn>;
  /** Upstream names the channel's accounts offer (excluded ones included): the name suggestions and match targets. */
  readonly upstreams: ReadonlyArray<string>;
  /**
   * Upstream names the provider's catalog gives its credentials, accounts and provider keys alike: the `like`
   * suggestions, and the names a write-in is no longer needed for.
   */
  readonly catalog: ReadonlyArray<string>;
  /** Upstream names a write-in of the channel serves right now, on some account or provider key. */
  readonly writtenIn: ReadonlyArray<string>;
  /** Provider keys of the provider, which its write-ins reach though its other rules do not. */
  readonly keys: number;
  /** No account uses the channel, so its rules change nothing. */
  readonly inert: boolean;
}

/**
 * What a write-in does now: `serving` (some credential serves it), `listed` (the catalog lists the name, so the
 * write-in changes nothing and can go), `idle` (no credential of the provider takes its models from the catalog).
 */
export const writeInState = (
  rules: ChannelRules,
  entry: ModelWriteIn,
): "serving" | "listed" | "idle" => {
  const name = lower(entry.name);

  if (rules.catalog.some((upstream) => lower(upstream) === name)) return "listed";

  return rules.writtenIn.some((upstream) => lower(upstream) === name) ? "serving" : "idle";
};

/** Adds `value` to the set `map` holds under `key`. */
const addTo = (map: Map<string, Set<string>>, key: string, value: string): void => {
  const names = map.get(key) ?? new Set<string>();
  names.add(value);
  map.set(key, names);
};

/** Every channel with accounts or rules (plus `extra`, channels the operator is adding), by name. */
export const channelRules = (
  view: RoutingModels,
  extra: ReadonlyArray<string> = [],
): ReadonlyArray<ChannelRules> => {
  const accounts = new Map(view.channels.map((entry) => [entry.channel, entry.accounts]));
  const upstreams = new Map<string, Set<string>>();
  const catalog = new Map<string, Set<string>>();
  const writtenIn = new Map<string, Set<string>>();
  const keys = new Map<string, Set<string>>();

  for (const model of view.models) {
    for (const route of model.routes) {
      const provider = lower(route.provider);

      if (route.channel !== undefined) addTo(upstreams, route.channel, route.upstream);

      if (route.via === "catalog") addTo(catalog, provider, route.upstream);

      if (route.via === "write-in") addTo(writtenIn, provider, route.upstream);

      if (route.source === "config") addTo(keys, provider, route.auth_index);
    }
  }

  const names = new Set([
    ...accounts.keys(),
    ...Object.keys(view.aliases),
    ...Object.keys(view.excluded),
    ...Object.keys(view.write_ins),
    ...extra,
  ]);

  const sorted = (set: Set<string> | undefined) => [...(set ?? [])].toSorted(compareIds);

  return [...names].toSorted(compareIds).map((channel) => {
    const count = accounts.get(channel) ?? 0;

    return {
      channel,
      accounts: count,
      aliases: view.aliases[channel] ?? [],
      excluded: view.excluded[channel] ?? [],
      writeIns: view.write_ins[channel] ?? [],
      upstreams: sorted(upstreams.get(channel)),
      catalog: sorted(catalog.get(channel)),
      writtenIn: sorted(writtenIn.get(channel)),
      keys: keys.get(channel)?.size ?? 0,
      inert: count === 0,
    };
  });
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether an exclusion pattern matches a model name: case-insensitive, `*` matches any characters, anything else
 * is literal (the server's `matchWildcard`, packages/models/src/credentials/selection/model-name.ts).
 */
export const patternMatches = (pattern: string, name: string): boolean => {
  const normalised = lower(pattern);

  if (normalised === "") return false;

  return new RegExp(`^${normalised.split("*").map(escapeRegExp).join(".*")}$`).test(lower(name));
};

/** The names a pattern would exclude. */
export const exclusionMatches = (
  pattern: string,
  names: ReadonlyArray<string>,
): ReadonlyArray<string> => names.filter((name) => patternMatches(pattern, name));

// ---------------------------------------------------------------------------------------------------------------
// Drafts

/** Channel keys as the config stores them: lower-case letters, digits, dots and dashes. */
const CHANNEL = /^[a-z0-9.-]+$/;

export const validateChannel = (
  raw: string,
  known: ReadonlyArray<string> = [],
): string | undefined => {
  const channel = raw.trim();

  if (channel === "")
    return "Enter a channel, the provider key of its accounts (claude, codex, …).";

  if (!CHANNEL.test(channel)) return "Use lower-case letters, digits, dots and dashes only.";

  if (known.includes(channel)) return "This channel is already on the page.";

  return undefined;
};

export interface AliasDraft {
  readonly name: string;
  readonly alias: string;
  readonly fork: boolean;
}

export interface AliasErrors {
  readonly name?: string;
  readonly alias?: string;
}

export const hasAliasErrors = (errors: AliasErrors): boolean =>
  errors.name !== undefined || errors.alias !== undefined;

/** The alias field's error alone: missing, the provider's own name, or taken by another entry of the channel. */
const aliasError = (
  alias: string,
  name: string,
  existing: ReadonlyArray<OAuthModelAliasWire>,
  editing: OAuthModelAliasWire | undefined,
): AliasErrors => {
  if (alias === "") return { alias: "Enter the name clients will call." };

  if (lower(alias) === lower(name))
    return { alias: "This is the provider's name already. Choose a different one." };

  const taken = existing.find((entry) => entry !== editing && lower(entry.alias) === lower(alias));

  return taken === undefined
    ? {}
    : { alias: `${taken.alias} is already the alias of ${taken.name} on this channel.` };
};

/** A draft against the channel's aliases (`editing`: the entry it replaces, which may keep its own alias). */
export const validateAlias = (
  draft: AliasDraft,
  existing: ReadonlyArray<OAuthModelAliasWire>,
  editing?: OAuthModelAliasWire,
): AliasErrors => {
  const name = draft.name.trim();
  const alias = draft.alias.trim();
  const nameError = name === "" ? "Enter the provider's model name." : undefined;

  return nameError === undefined
    ? aliasError(alias, name, existing, editing)
    : { name: nameError, ...aliasError(alias, name, existing, editing) };
};

/** The entry a draft becomes; an edited entry keeps the settings the form does not show. */
export const aliasEntry = (
  draft: AliasDraft,
  editing?: OAuthModelAliasWire,
): OAuthModelAliasWire => {
  const { fork: _fork, ...kept } = editing ?? { name: "", alias: "" };

  return {
    ...kept,
    name: draft.name.trim(),
    alias: draft.alias.trim(),
    ...(draft.fork ? { fork: true } : {}),
  };
};

export interface WriteInDraft {
  readonly name: string;
  readonly like: string;
  readonly displayName: string;
}

export interface WriteInErrors {
  readonly name?: string;
  readonly like?: string;
}

export const hasWriteInErrors = (errors: WriteInErrors): boolean =>
  errors.name !== undefined || errors.like !== undefined;

/** The model id field's error: missing, with spaces, listed by the catalog already, or written in already. */
const writeInNameError = (name: string, rules: ChannelRules): string | undefined => {
  if (name === "") return "Enter the model's id, as the provider names it.";

  if (/\s/.test(name)) return "A model id has no spaces.";

  if (rules.catalog.some((upstream) => lower(upstream) === lower(name)))
    return `The catalog lists ${name} already.`;

  if (rules.writeIns.some((entry) => lower(entry.name) === lower(name)))
    return `${name} is written in already.`;

  return undefined;
};

/** The like field's error (optional field): with spaces, or the write-in itself. */
const writeInLikeError = (like: string, name: string): string | undefined => {
  if (/\s/.test(like)) return "A model id has no spaces.";

  return like !== "" && lower(like) === lower(name)
    ? "Choose a catalog model other than the write-in itself."
    : undefined;
};

/** A draft against the channel's write-ins and catalog: a new name, without spaces, that the catalog lacks. */
export const validateWriteIn = (draft: WriteInDraft, rules: ChannelRules): WriteInErrors => {
  const name = draft.name.trim();
  const nameError = writeInNameError(name, rules);
  const likeError = writeInLikeError(draft.like.trim(), name);
  const errors: Types.Mutable<WriteInErrors> = {};

  if (nameError !== undefined) errors.name = nameError;

  if (likeError !== undefined) errors.like = likeError;

  return errors;
};

/** The entry a draft becomes. */
export const writeInEntry = (draft: WriteInDraft): ModelWriteIn => {
  const like = draft.like.trim();
  const displayName = draft.displayName.trim();
  const entry: Types.Mutable<ModelWriteIn> = { name: draft.name.trim() };

  if (like !== "") entry.like = like;

  if (displayName !== "") entry["display-name"] = displayName;

  return entry;
};

export const validatePattern = (
  raw: string,
  existing: ReadonlyArray<string>,
): string | undefined => {
  const pattern = lower(raw);

  if (pattern === "") return "Enter a model name, or a pattern with *.";

  if (/\s/.test(pattern)) return "A pattern has no spaces.";

  if (existing.some((entry) => lower(entry) === pattern))
    return "This pattern is already excluded.";

  return undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// Rule edits

/** One edit of one channel's rules: what the operator did, re-applicable to a newer list. */
export type RuleChange =
  | {
      readonly rule: "aliases";
      readonly channel: string;
      readonly op: "add" | "remove";
      readonly entry: OAuthModelAliasWire;
    }
  | {
      readonly rule: "aliases";
      readonly channel: string;
      readonly op: "replace";
      readonly from: OAuthModelAliasWire;
      readonly to: OAuthModelAliasWire;
    }
  | {
      readonly rule: "excluded";
      readonly channel: string;
      readonly op: "add" | "remove";
      readonly pattern: string;
    }
  | {
      readonly rule: "write-ins";
      readonly channel: string;
      readonly op: "add" | "remove";
      readonly entry: ModelWriteIn;
    };

/** The request a change becomes: the channel's whole list, or deleting it when the list ends up empty. */
export type RuleWrite =
  | {
      readonly kind: "put-aliases";
      readonly channel: string;
      readonly body: ReadonlyArray<OAuthModelAliasWire>;
    }
  | { readonly kind: "delete-aliases"; readonly channel: string }
  | {
      readonly kind: "put-excluded";
      readonly channel: string;
      readonly body: ReadonlyArray<string>;
    }
  | { readonly kind: "delete-excluded"; readonly channel: string }
  | {
      readonly kind: "put-write-ins";
      readonly channel: string;
      readonly body: ReadonlyArray<ModelWriteIn>;
    }
  | { readonly kind: "delete-write-ins"; readonly channel: string };

/** `none`: the list already says what the change wants; `conflict`: the entry it touches changed meanwhile. */
export type RulePlan =
  | { readonly kind: "write"; readonly write: RuleWrite }
  | { readonly kind: "none" }
  | { readonly kind: "conflict" };

const sameAlias = (a: OAuthModelAliasWire, b: OAuthModelAliasWire): boolean =>
  lower(a.name) === lower(b.name) &&
  lower(a.alias) === lower(b.alias) &&
  (a.fork ?? false) === (b.fork ?? false) &&
  (a["display-name"] ?? "") === (b["display-name"] ?? "") &&
  (a["force-mapping"] ?? false) === (b["force-mapping"] ?? false);

const NONE: RulePlan = { kind: "none" };

const CONFLICT: RulePlan = { kind: "conflict" };

const aliasPlan = (channel: string, list: ReadonlyArray<OAuthModelAliasWire>): RulePlan => ({
  kind: "write",
  write:
    list.length === 0
      ? { kind: "delete-aliases", channel }
      : { kind: "put-aliases", channel, body: list },
});

const sameWriteIn = (a: ModelWriteIn, b: ModelWriteIn): boolean =>
  lower(a.name) === lower(b.name) &&
  lower(a.like ?? "") === lower(b.like ?? "") &&
  (a["display-name"] ?? "") === (b["display-name"] ?? "");

/** A write-in edit: adding a name another edit wrote in differently, or removing one changed since, conflicts. */
const writeInPlan = (
  view: Pick<RoutingModels, "write_ins">,
  channel: string,
  op: "add" | "remove",
  entry: ModelWriteIn,
): RulePlan => {
  const current = view.write_ins[channel] ?? [];
  const index = current.findIndex((item) => lower(item.name) === lower(entry.name));
  const found = current[index];

  if (op === "add") {
    if (found !== undefined) return sameWriteIn(found, entry) ? NONE : CONFLICT;

    return { kind: "write", write: { kind: "put-write-ins", channel, body: [...current, entry] } };
  }

  if (found === undefined) return NONE;

  if (!sameWriteIn(found, entry)) return CONFLICT;
  const next = current.toSpliced(index, 1);

  return {
    kind: "write",
    write:
      next.length === 0
        ? { kind: "delete-write-ins", channel }
        : { kind: "put-write-ins", channel, body: next },
  };
};

/** The write `change` needs against `view`'s rule maps (the page's own view, or a fresh one after a 409). */
export const planRuleChange = (
  view: Pick<RoutingModels, "aliases" | "excluded" | "write_ins">,
  change: RuleChange,
): RulePlan => {
  const { channel } = change;

  if (change.rule === "write-ins") return writeInPlan(view, channel, change.op, change.entry);

  if (change.rule === "excluded") {
    const current = view.excluded[channel] ?? [];
    const pattern = lower(change.pattern);
    const present = current.some((entry) => lower(entry) === pattern);

    if (change.op === "add" ? present : !present) return NONE;

    const next =
      change.op === "add"
        ? [...current, pattern]
        : current.filter((entry) => lower(entry) !== pattern);

    return {
      kind: "write",
      write:
        next.length === 0
          ? { kind: "delete-excluded", channel }
          : { kind: "put-excluded", channel, body: next },
    };
  }

  const current = view.aliases[channel] ?? [];

  const holding = (alias: string, except?: number) =>
    current.findIndex((entry, index) => index !== except && lower(entry.alias) === lower(alias));

  switch (change.op) {
    case "add": {
      const index = holding(change.entry.alias);

      if (index === -1) return aliasPlan(channel, [...current, change.entry]);

      const entry = current[index];

      return entry !== undefined && sameAlias(entry, change.entry) ? NONE : CONFLICT;
    }

    case "remove": {
      const index = current.findIndex((entry) => sameAlias(entry, change.entry));

      if (index !== -1) return aliasPlan(channel, current.toSpliced(index, 1));

      // Gone already is what the removal wanted; the same alias with other settings is someone else's edit.
      return holding(change.entry.alias) === -1 ? NONE : CONFLICT;
    }

    case "replace": {
      const index = current.findIndex((entry) => sameAlias(entry, change.from));

      if (index === -1) {
        const now = current.find((entry) => sameAlias(entry, change.to));

        return now === undefined ? CONFLICT : NONE;
      }

      if (sameAlias(change.from, change.to)) return NONE;

      if (holding(change.to.alias, index) !== -1) return CONFLICT;

      return aliasPlan(channel, current.toSpliced(index, 1, change.to));
    }
  }
};

/** The revision of the channel entry a write replaces or removes (0: the channel has none): its `If-Match` value. */
/** The `revisions` map of the entry kind each write replaces or removes. */
const REVISIONS_OF: Readonly<Record<RuleWrite["kind"], keyof RoutingModels["revisions"]>> = {
  "put-aliases": "aliases",
  "delete-aliases": "aliases",
  "put-excluded": "exclusions",
  "delete-excluded": "exclusions",
  "put-write-ins": "write_ins",
  "delete-write-ins": "write_ins",
};

export const ruleRevision = (view: Pick<RoutingModels, "revisions">, write: RuleWrite): number =>
  view.revisions[REVISIONS_OF[write.kind]][write.channel] ?? 0;

/** How `saveRuleChange` reads the latest rules and sends one write (`revision`: the `If-Match` value). */
export interface RuleIo<E, R> {
  readonly read: Effect.Effect<RoutingModels, E, R>;
  readonly write: (write: RuleWrite, revision: number) => Effect.Effect<unknown, E, R>;
}

const conflict = () => new ManagementError({ error: "conflict" });

/**
 * Saves `change` against the view the page shows, naming the revision of the channel entry it replaces. When that
 * entry changed since (409 `conflict`; other channels never conflict), re-reads the view, re-applies the same change
 * to the latest list and tries once more; a second refusal, or the touched entry having changed meanwhile, fails with
 * `conflict` for the operator to reload. `unchanged` when the list already held it.
 */
export const saveRuleChange = <E, R>(
  change: RuleChange,
  base: RoutingModels,
  io: RuleIo<E, R>,
): Effect.Effect<"saved" | "unchanged", E | ManagementError, R> => {
  const attempt = (
    view: RoutingModels,
  ): Effect.Effect<"saved" | "unchanged", E | ManagementError, R> => {
    const plan = planRuleChange(view, change);

    if (plan.kind === "none") return Effect.succeed("unchanged");

    if (plan.kind === "conflict") return Effect.fail(conflict());

    const deleting = plan.write.kind.startsWith("delete-");

    return io.write(plan.write, ruleRevision(view, plan.write)).pipe(
      Effect.as("saved" as const),
      // Deleting a list another edit already removed leaves what this one wanted.
      Effect.catchIf(
        (error) => deleting && error instanceof ManagementError && error.error === "not_found",
        () => Effect.succeed("saved" as const),
      ),
    );
  };

  return attempt(base).pipe(
    Effect.catchIf(
      (error) => error instanceof ManagementError && error.error === "conflict",
      () => Effect.flatMap(io.read, attempt),
    ),
  );
};

/** What a failed rule save tells the operator. */
export const ruleProblem = (error: string | undefined, message: string): string =>
  error === "conflict"
    ? "The rules changed elsewhere while this page was open, and this edit no longer fits them. Reload to see the current rules, then make the edit again."
    : message;
