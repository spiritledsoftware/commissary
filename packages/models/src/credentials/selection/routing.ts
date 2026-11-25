/**
 * Per-credential model routing: prefixes, exclusions and aliases (client-visible model -> upstream model).
 *
 * Go source: sdk/cliproxy/service_models.go (`applyModelPrefixes`, `applyExcludedModels`, OAuth alias registration),
 * sdk/cliproxy/auth/conductor_models.go (`rewriteModelForAuth`, `executionModelCandidatesWithAlias`),
 * sdk/cliproxy/auth/oauth_model_alias.go (alias resolution). Docs: credentials.md §6.6-6.8.
 *
 * The Go server decides model support through the global model registry (catalogue per provider, filtered per
 * credential at registration time). On Workers the caller resolves the provider set; this module applies the
 * per-credential parts of the registry rules (prefix, exclusion, configured `models`, aliases).
 */
import type { OAuthModelAlias } from "../../config/schema.ts";
import type { Credential } from "../model.ts";
import {
  canonicalModelKey,
  isModelExcluded,
  parseModelSuffix,
  preserveResolvedSuffix,
  type ModelSuffix,
} from "./model-name.ts";

export interface RoutingContext {
  /** `routing.force-model-prefix`: credentials with a prefix only serve `prefix/model`. */
  readonly forceModelPrefix: boolean;
  /** `oauth.model-alias`: channel -> aliases. */
  readonly oauthModelAlias: Readonly<Record<string, ReadonlyArray<OAuthModelAlias>>>;
  /** Prefixes of all enabled credentials (`team-a`): a leading `team-a/` is only meaningful to those credentials. */
  readonly knownPrefixes: ReadonlySet<string>;
}

/** Result of routing one requested model through one credential. */
export interface ModelRoute {
  /** The model as the client sent it. */
  readonly requestedModel: string;
  /** `requestedModel` without this credential's prefix (`rewriteModelForAuth`). */
  readonly routeModel: string;
  /** Upstream model name (thinking suffix preserved). First entry of `upstreamModels`. */
  readonly upstreamModel: string;
  /** Pool of upstream models for configured aliases shared by several `models:` entries, rotated by `poolOffset`. */
  readonly upstreamModels: ReadonlyArray<string>;
  /** Model name clients should see in responses: the request, or the configured alias with `force-mapping`. */
  readonly originalAlias: string;
  readonly forceMapping: boolean;
  /** Model used for the availability check and cooldown state key (alias-resolved for OAuth credentials). */
  readonly selectionModel: string;
  /** Several upstream models share the alias: cooldown state is tracked per upstream model. */
  readonly pooled?: boolean;
}

interface AliasResult {
  readonly upstreamModel: string;
  readonly forceMapping: boolean;
  readonly originalAlias: string;
}

const NO_ALIAS: AliasResult = { upstreamModel: "", forceMapping: false, originalAlias: "" };

interface LookupCandidates {
  readonly suffix: ModelSuffix;
  readonly candidates: string[];
}

const lookupCandidates = (requested: string): LookupCandidates => {
  const trimmed = requested.trim();

  if (trimmed === "") return { suffix: parseModelSuffix(""), candidates: [] };
  const suffix = parseModelSuffix(trimmed);
  const base = suffix.modelName === "" ? trimmed : suffix.modelName;

  return { suffix, candidates: base === trimmed ? [trimmed] : [trimmed, base] };
};

interface AliasEntry {
  readonly name: string;
  readonly alias: string;
  readonly forceMapping: boolean;
}

const equalFold = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * `resolveUpstreamModelFromAliases` / `resolveModelAliasResultFromConfigModels`: first alias match wins; `undefined`
 * when no alias matches. An alias of the requested model itself maps nothing unless it forces the mapping. OAuth
 * aliases compare that model name exactly, so a case-only alias maps (34d8fe0f); configured models ignore case.
 */
const resolveAlias = (
  entries: ReadonlyArray<AliasEntry>,
  requested: string,
  sameModel: (name: string, base: string) => boolean,
): AliasResult | undefined => {
  const { suffix, candidates } = lookupCandidates(requested);

  if (candidates.length === 0 || entries.length === 0) return undefined;
  const base = suffix.modelName === "" ? requested.trim() : suffix.modelName;

  for (const candidate of candidates) {
    for (const entry of entries) {
      const name = entry.name.trim();
      const alias = entry.alias.trim();

      if (name === "" || alias === "" || !equalFold(alias, candidate)) continue;

      if (sameModel(name, base)) {
        if (!entry.forceMapping) return NO_ALIAS;

        return {
          upstreamModel: preserveResolvedSuffix(name, suffix),
          forceMapping: true,
          originalAlias: alias,
        };
      }

      return {
        upstreamModel: preserveResolvedSuffix(name, suffix),
        forceMapping: entry.forceMapping,
        originalAlias: entry.forceMapping ? alias : requested,
      };
    }
  }

  return undefined;
};

const exactName = (name: string, base: string): boolean => name === base;

/** `resolveModelAliasPoolFromConfigModels`: every upstream name behind the matching alias, else a name match. */
export const resolveModelPool = (
  entries: ReadonlyArray<{ readonly name: string; readonly alias?: string | undefined }>,
  requested: string,
): string[] => {
  const { suffix, candidates } = lookupCandidates(requested);

  for (const candidate of candidates) {
    const out: string[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      const name = entry.name.trim();
      const alias = (entry.alias ?? "").trim();

      if (alias === "" || !equalFold(alias, candidate)) continue;
      const resolved = preserveResolvedSuffix(name === "" ? candidate : name, suffix);
      const key = resolved.toLowerCase();

      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      out.push(resolved);
    }

    if (out.length > 0) return out;
  }

  for (const candidate of candidates) {
    for (const entry of entries) {
      const name = entry.name.trim();

      if (name !== "" && equalFold(name, candidate)) return [preserveResolvedSuffix(name, suffix)];
    }
  }

  return [];
};

/** `OAuthModelAliasChannel`: provider-key credentials and Gemini provider keys have no OAuth alias channel. */
export const oauthAliasChannel = (
  credential: Pick<Credential, "provider" | "authKind">,
): string => {
  if (credential.authKind === "apikey") return "";
  const provider = credential.provider.trim().toLowerCase();

  return provider === "gemini" ? "" : provider;
};

const entryOf = (alias: OAuthModelAlias): AliasEntry => ({
  name: alias.name,
  alias: alias.alias,
  forceMapping: alias["force-mapping"] === true,
});

/**
 * The part of a credential that routing reads: a `Credential`, or a `ModelSource` (the registry asks the same question
 * selection does, which models a credential serves, without its tokens).
 */
export type RoutableCredential = Pick<
  Credential,
  "prefix" | "models" | "excludedModels" | "modelAliases" | "provider" | "authKind"
>;

/** Splits `prefix/` off the model. `undefined` when this credential cannot serve the model for prefix reasons. */
const applyPrefix = (
  credential: RoutableCredential,
  requested: string,
  context: RoutingContext,
): string | undefined => {
  const prefix = credential.prefix ?? "";

  if (prefix !== "" && requested.startsWith(`${prefix}/`))
    return requested.slice(prefix.length + 1);

  if (prefix !== "" && context.forceModelPrefix && canonicalModelKey(requested) !== prefix)
    return undefined;
  const slash = requested.indexOf("/");

  // `team-a/gpt-5` belongs to credentials whose prefix is `team-a`; others only serve it when they list it explicitly.
  if (
    slash > 0 &&
    context.knownPrefixes.has(requested.slice(0, slash)) &&
    credential.models === undefined
  ) {
    return undefined;
  }

  return requested;
};

/** Rotates the upstream pool of a route (successive requests start on different upstream models). */
export const rotateRoute = (route: ModelRoute, offset: number): ModelRoute => {
  const size = route.upstreamModels.length;

  if (size < 2) return route;
  const start = ((offset % size) + size) % size;

  if (start === 0) return route;

  const upstreamModels = [
    ...route.upstreamModels.slice(start),
    ...route.upstreamModels.slice(0, start),
  ];

  return { ...route, upstreamModel: upstreamModels[0] ?? "", upstreamModels };
};

/**
 * Routes `requested` through `credential`: strips its prefix, applies exclusions and resolves the alias.
 * Returns `undefined` when the credential does not serve the model. Pools are returned in configured order.
 */
export const resolveModelRoute = (
  credential: RoutableCredential,
  requested: string,
  context: RoutingContext,
): ModelRoute | undefined => {
  const requestedModel = requested.trim();

  if (requestedModel === "") return undefined;
  const routeModel = applyPrefix(credential, requestedModel, context);

  if (routeModel === undefined || routeModel.trim() === "") return undefined;

  const route = (
    fields: Pick<
      ModelRoute,
      "upstreamModels" | "originalAlias" | "forceMapping" | "selectionModel"
    >,
  ) => {
    const upstreamModels = fields.upstreamModels;

    return {
      requestedModel,
      routeModel,
      upstreamModel: upstreamModels[0] ?? "",
      ...fields,
    } satisfies ModelRoute;
  };

  const excluded = (...models: string[]): boolean =>
    models.some((model) => isModelExcluded(credential.excludedModels, model));

  // Configured provider-key models replace the provider catalogue.
  if (credential.models !== undefined && credential.models.length > 0) {
    const pool = resolveModelPool(credential.models, routeModel);

    if (pool.length === 0) return undefined;

    if (excluded(routeModel, ...pool)) return undefined;

    const alias =
      resolveAlias(
        credential.models.map((model) => ({
          name: model.name,
          alias: model.alias ?? "",
          forceMapping: model["force-mapping"] === true,
        })),
        routeModel,
        equalFold,
      ) ?? NO_ALIAS;

    return route({
      upstreamModels: pool,
      originalAlias: alias.forceMapping ? alias.originalAlias : routeModel,
      forceMapping: alias.forceMapping,
      selectionModel: routeModel,
    });
  }

  const channel = oauthAliasChannel(credential);
  let alias = NO_ALIAS;

  // A matching per-account alias decides, even when it maps nothing; only no match falls through (34d8fe0f).
  if (channel !== "") {
    alias =
      resolveAlias(credential.modelAliases.map(entryOf), routeModel, exactName) ??
      resolveAlias((context.oauthModelAlias[channel] ?? []).map(entryOf), routeModel, exactName) ??
      NO_ALIAS;
  }

  const upstream = alias.upstreamModel === "" ? routeModel : alias.upstreamModel;

  // Exclusions apply to catalogue (upstream) names; the alias is derived from them.
  if (excluded(upstream)) return undefined;

  return route({
    upstreamModels: [upstream],
    originalAlias: alias.upstreamModel === "" ? routeModel : alias.originalAlias,
    forceMapping: alias.forceMapping,
    selectionModel: upstream,
  });
};
