/**
 * The toolkit catalog (`/v9/management/toolkit-catalog`, `packages/tools/src/catalog/`; ADR 0036, #207): the services
 * an org admin or member can add a toolkit from, with each one's sources and how to sign in to them, built from
 * integrations.sh's registry and the toolkit catalog additions. Shared with the browser: imports `effect`, `./errors.ts`,
 * `./catalog.ts` and `./tools.ts` only.
 *
 * The catalog is the deployment's, the same for every org: a copy of integrations.sh's index ships with Commissary and
 * a scheduled task refreshes it every 3 hours (`refresh` runs it now, org admins; a refresh that fails keeps the
 * catalog; `status` tells which copy is in use and how the last attempt went). A service's `id` is its catalog slug, the default name of a toolkit added from it (ADR 0037). Adding a
 * toolkit from a service's source (`POST /toolkits` with `catalog`, `@commissary/contract/tools`) fills its kind,
 * source, name and credential settings, and gives its tools the additions' overrides.
 *
 * A domain the catalog lacks is looked up live (`lookup`: integrations.sh's quick `detect`; `discover`, its slower
 * reading of the service's docs, only when asked). The answer is a service of the same shape that fills one toolkit,
 * never the catalog. The domain, and every source URL in the answer, passes the outbound guard: a domain it refuses is
 * `422` with the guard's message as `error` and `path: "domain"`, and a source URL it refuses is left out (`refused`).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { CatalogAttempt } from "./catalog.ts";
import { managementErrors } from "./errors.ts";
import { AddedToolkitKind, CatalogCredential, CredentialSettings } from "./tools.ts";

const optional = Schema.optionalKey;

export { CatalogCredential } from "./tools.ts";

/** One source of a service: what a toolkit is built from. */
export const CatalogSource = Schema.Struct({
  /** integrations.sh's stable identifier of the surface, or the additions'. */
  id: Schema.String,
  kind: AddedToolkitKind,
  name: Schema.String,
  /** The MCP server's URL, the OpenAPI or Discovery document's, or the GraphQL endpoint's. */
  url: Schema.String,
  /** The ways to sign in, any one of them; empty: not known (an OpenAPI document says so itself). */
  credentials: Schema.Array(CatalogCredential),
  /** The settings its credential types need (a JWT's algorithm and token endpoint, AWS's region and service). */
  credential_settings: optional(CredentialSettings),
  /** The OAuth scopes it needs. */
  scopes: optional(Schema.Array(Schema.String)),
  /**
   * On Commissary Cloud: its OAuth sign-ins use Commissary Cloud's own OAuth app with the service, unless the toolkit
   * is given an OAuth app of the org's.
   */
  managed_oauth_app: optional(Schema.Literal(true)),
  /** A toolkit catalog addition corrects what integrations.sh says of it (the correction is offered upstream too). */
  corrected: optional(Schema.Literal(true)),
});

export type CatalogSource = typeof CatalogSource.Type;

/** A service as the catalog lists it. */
export const CatalogServiceSummary = Schema.Struct({
  /** Its catalog slug, the default name of a toolkit added from it (ADR 0037). */
  id: Schema.String,
  name: Schema.String,
  domain: Schema.String,
  description: optional(Schema.String),
  icon: optional(Schema.String),
  categories: Schema.Array(Schema.String),
  /** On the additions' featured list: listed first. */
  featured: Schema.Boolean,
  /** The kinds of its sources, each once. */
  kinds: Schema.Array(AddedToolkitKind),
});

export type CatalogServiceSummary = typeof CatalogServiceSummary.Type;

export const CatalogService = Schema.Struct({
  ...CatalogServiceSummary.fields,
  sources: Schema.Array(CatalogSource),
});

export type CatalogService = typeof CatalogService.Type;

/** A page of the catalog: featured services first, then by popularity. */
export const CatalogPage = Schema.Struct({
  services: Schema.Array(CatalogServiceSummary),
  /** Services that match, on every page. */
  total: Schema.Int,
});

export type CatalogPage = typeof CatalogPage.Type;

/**
 * What a domain looks up to: its catalog service (`via: "catalog"`), or what integrations.sh's `detect` or `discover`
 * found (a service with the domain's slug as its `id`, for one toolkit only; not in the catalog).
 */
export const DomainLookup = Schema.Struct({
  via: Schema.Literals(["catalog", "detect", "discover"]),
  service: CatalogService,
  /** Source URLs the answer named that the outbound guard refuses: left out. */
  refused: optional(Schema.Array(Schema.String)),
});

export type DomainLookup = typeof DomainLookup.Type;

/** How a refresh of the catalog ended: the stored copy changed, was already current, or the attempt failed. */
export const ToolkitCatalogRefresh = Schema.Struct({
  status: Schema.Literals(["updated", "unchanged", "failed"]),
  /** Why it failed (a fixed message, never a URL or upstream body). */
  message: optional(Schema.String),
  /** Sources in the stored registry. */
  sources: optional(Schema.Int),
});

export type ToolkitCatalogRefresh = typeof ToolkitCatalogRefresh.Type;

/** Which copy of the catalog is in use, and the latest refresh attempt (the scheduled one or an org admin's). */
export const ToolkitCatalogStatus = Schema.Struct({
  /** `true` when the catalog in use is a refreshed copy from KV, `false` for the copy shipped with Commissary. */
  stored: Schema.Boolean,
  /** ISO time the stored copy was last confirmed current (a refresh that updated it or found it unchanged). */
  refreshed_at: optional(Schema.String),
  /** The latest refresh attempt; its `message` is a fixed text, never a URL or upstream body. */
  last_attempt: optional(CatalogAttempt),
  /** Services and sources in the catalog in use. */
  services: Schema.Int,
  sources: Schema.Int,
});

export type ToolkitCatalogStatus = typeof ToolkitCatalogStatus.Type;

export class ToolkitCatalogGroup extends HttpApiGroup.make("toolkitCatalog").add(
  /**
   * The catalog's services, featured first: `q` matches words of a service's name, slug, domain, description and
   * categories; `kind` keeps those with a source of that kind. `limit` defaults to 50 (at most 200).
   */
  HttpApiEndpoint.get("list", "/toolkit-catalog", {
    query: {
      q: optional(Schema.String),
      kind: optional(AddedToolkitKind),
      limit: optional(Schema.FiniteFromString),
      offset: optional(Schema.FiniteFromString),
    },
    success: CatalogPage,
    error: managementErrors,
  }),
  HttpApiEndpoint.get("service", "/toolkit-catalog/services/:id", {
    params: { id: Schema.String },
    success: CatalogService,
    error: managementErrors,
  }),
  /**
   * A domain's service: the catalog's, else integrations.sh's `detect` (`502 lookup_failed` when it cannot be reached;
   * `429 lookup_rate_limited` past ten a minute for one member). `422` with the outbound guard's message as `error` and
   * `path: "domain"` for a domain it refuses.
   */
  HttpApiEndpoint.get("lookup", "/toolkit-catalog/domains/:domain", {
    params: { domain: Schema.String },
    success: DomainLookup,
    error: managementErrors,
  }),
  /**
   * integrations.sh's `discover` of a domain: slower (up to a minute), once a minute for the whole org and rate-limited
   * by integrations.sh too (`429 lookup_rate_limited` for either). Answers as `lookup` does; nothing is kept.
   */
  HttpApiEndpoint.post("discover", "/toolkit-catalog/domains/:domain/discover", {
    params: { domain: Schema.String },
    success: DomainLookup,
    error: managementErrors,
  }),
  HttpApiEndpoint.get("status", "/toolkit-catalog/status", {
    success: ToolkitCatalogStatus,
    error: managementErrors,
  }),
  /**
   * Refresh the catalog now (org admins): the scheduled task's operation. A failed download, size or validation problem
   * is a `200` with `status: "failed"` (the stored catalog stays); `409 catalog_refresh_running` while another refresh
   * runs.
   */
  HttpApiEndpoint.post("refresh", "/toolkit-catalog/refresh", {
    success: ToolkitCatalogRefresh,
    error: managementErrors,
  }),
) {}
