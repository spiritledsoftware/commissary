/**
 * A domain the toolkit catalog lacks, looked up live at integrations.sh (ADR 0036, #207): its quick `detect`
 * (`/api/<domain>/detect`: the domain's well-known manifests, its MCP server and its OpenAPI document, probed) when the
 * domain is added, and its slower `discover` (`/api/<domain>/discover`: an agent reads the service's docs; up to a
 * minute, and integrations.sh allows 3 a minute) only when asked. The answer is a catalog service of the same shape
 * (`catalog.ts`) that fills one org's toolkit: nothing of it is kept, and the shared catalog never changes.
 *
 * Every user-supplied URL passes the outbound guard (ADR 0044): the domain itself before integrations.sh is asked
 * (`https://<domain>/`), and each source URL in the answer, which is left out (`refused`) when the guard refuses it.
 * The toolkit's source passes it again when it is saved, as any source does. The requests to integrations.sh go through
 * the guarded client too.
 *
 * Both answers are read leniently: an entry that does not decode is skipped. `detect` names MCP servers (with whether
 * they sign in with OAuth), OpenAPI documents and the owner's own `integrations.json` (the discovery model v3, as
 * `discover` answers it); `discover` names the service's surfaces and its credential registry, read as the sync script
 * reads a domain's `/surface` document (`credentials.ts`), whose types map onto toolkit credentials.
 */
import { Brand, Data, Duration, Effect, Result, Schema } from "effect";
import type { DomainLookup } from "@commissary/contract/toolkit-catalog";
import { checkOutboundUrl, CurrentOutboundPolicy } from "@commissary/core";
import { fetchDocument } from "../http/call.ts";
import type { CatalogSourceKind } from "./additions.ts";
import type { CatalogEntry, CatalogEntrySource } from "./catalog.ts";
import { serviceView } from "./catalog.ts";
import { type CatalogAuth, Discovery, discoveredSurfaces } from "./credentials.ts";
import { buildableUrl } from "./integrations-sh.ts";
import { domainSlug } from "./slugs.ts";

/** integrations.sh's API. */
export const INTEGRATIONS_SH_API = "https://integrations.sh/api";

/** `detect` probes a handful of URLs on the domain: seconds. */
const DETECT_TIMEOUT = Duration.seconds(30);

/** `discover` reads the service's docs: up to a minute, by integrations.sh's account. */
const DISCOVER_TIMEOUT = Duration.seconds(90);

export type LookupVia = "detect" | "discover";

export class LookupError extends Data.TaggedError("CatalogLookupError")<{
  /**
   * - `invalid`: not a domain;
   * - `refused`: the outbound guard refuses the domain (its message);
   * - `rate_limited`: integrations.sh asks to wait (`discover`);
   * - `failed`: integrations.sh could not be reached or answered something else.
   */
  readonly reason: "invalid" | "refused" | "rate_limited" | "failed";
  readonly message: string;
}> {}

/** A host name: letters, digits and hyphens in two labels or more. */
const DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A domain {@link checkedDomain} has checked: what {@link lookupDomain} takes, so the guard sees it once. */
export type CheckedDomain = Brand.Branded<string, "CheckedDomain">;

const CheckedDomain = Brand.nominal<CheckedDomain>();

/**
 * `input` as a domain (lowercase, without a trailing dot; a URL's host when a URL is given), checked by the outbound
 * guard as `https://<domain>/`.
 */
export const checkedDomain = Effect.fnUntraced(function* (input: string) {
  const trimmed = input.trim().toLowerCase();
  const host = URL.canParse(trimmed) ? new URL(trimmed).hostname : trimmed;
  const domain = host.replace(/\.$/, "");

  if (!DOMAIN.test(domain))
    return yield* new LookupError({ reason: "invalid", message: "not a domain name" });

  const checked = checkOutboundUrl(`https://${domain}/`, yield* CurrentOutboundPolicy);

  if (Result.isFailure(checked))
    return yield* new LookupError({ reason: "refused", message: checked.failure.message });

  return CheckedDomain(domain);
});

const optional = Schema.optionalKey;

const McpDetection = Schema.Struct({
  url: Schema.String,
  auth: optional(Schema.NullOr(Schema.String)),
});

/** `detect`'s answer, as much of it as a toolkit needs. */
const Detection = Schema.Struct({
  mcp: optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  apiSchema: optional(Schema.NullOr(Schema.Struct({ url: Schema.String }))),
  apiCatalog: optional(
    Schema.NullOr(
      Schema.Struct({
        openapi: optional(Schema.Array(Schema.String)),
        mcp: optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
  integrationsJson: optional(Schema.NullOr(Schema.Struct({ result: optional(Schema.Unknown) }))),
});

/** A source as the answer names it, before the guard has seen its URL. */
interface Found {
  readonly id: string;
  readonly kind: CatalogSourceKind;
  readonly name: string;
  readonly url: string;
  readonly auth: ReadonlyArray<CatalogAuth>;
}

const decodeDiscovery = Schema.decodeEffect(Schema.fromJsonString(Discovery));

const decodeDetection = Schema.decodeEffect(Schema.fromJsonString(Detection));

/** `detect`'s answer, as much of it as a toolkit needs. */
type DetectionResult = typeof Detection.Type;

/** The sources of a v3 discovery result (`discover`'s, or an owner's `integrations.json`). */
const discoveredSources = (result: Discovery): ReadonlyArray<Found> =>
  discoveredSurfaces(result).map((surface, index) => ({
    id: surface.slug ?? `${surface.kind}-${index + 1}`,
    kind: surface.kind,
    name: surface.name ?? surface.url,
    url: surface.url,
    auth: surface.auth,
  }));

/** The sources `detect` found: the owner's own declaration first, then the MCP servers and OpenAPI documents. */
const detectedSources = (detection: DetectionResult): ReadonlyArray<Found> => {
  const { mcp, apiSchema, apiCatalog, integrationsJson } = detection;
  const declared = Schema.decodeUnknownResult(Discovery)(integrationsJson?.result);

  const servers = (mcp ?? []).flatMap((entry): ReadonlyArray<Found> => {
    const server = Schema.decodeUnknownResult(McpDetection)(entry);

    if (Result.isFailure(server)) return [];
    const { url, auth } = server.success;

    return [
      {
        id: "mcp",
        kind: "mcp",
        name: "MCP server",
        url,
        auth: auth === "oauth2" || auth === "none" ? [{ type: auth }] : [],
      },
    ];
  });

  const documents = [
    ...(apiSchema === undefined || apiSchema === null ? [] : [apiSchema.url]),
    ...(apiCatalog?.openapi ?? []),
  ].map((url): Found => ({ id: "openapi", kind: "openapi", name: "OpenAPI", url, auth: [] }));

  const catalogued = (apiCatalog?.mcp ?? []).map((url): Found => ({
    id: "mcp",
    kind: "mcp",
    name: "MCP server",
    url,
    auth: [],
  }));

  return [
    ...(Result.isSuccess(declared) ? discoveredSources(declared.success) : []),
    ...servers,
    ...catalogued,
    ...documents,
  ];
};

/**
 * The service the answer for `domain` makes, its sources each once (by URL) with unique ids, those the outbound guard
 * refuses left out and named.
 */
export const proposalOf = Effect.fnUntraced(function* (
  domain: string,
  found: ReadonlyArray<Found>,
  description: string | undefined,
) {
  const policy = yield* CurrentOutboundPolicy;
  const urls = new Set<string>();
  const ids = new Set<string>();
  const refused: Array<string> = [];
  const sources: Array<CatalogEntrySource> = [];

  for (const source of found) {
    if (!buildableUrl(source.url)) continue;
    const checked = checkOutboundUrl(source.url, policy);

    if (Result.isFailure(checked)) {
      if (!refused.includes(source.url)) refused.push(source.url);
      continue;
    }

    const url = checked.success.toString();

    if (urls.has(url)) continue;
    urls.add(url);
    let id = source.id;

    for (let n = 2; ids.has(id); n++) id = `${source.id}-${n}`;
    ids.add(id);
    sources.push({
      id,
      kind: source.kind,
      name: source.name,
      url,
      auth: source.auth,
      scopes: undefined,
      credentialSettings: undefined,
      specPatch: undefined,
      corrected: false,
    });
  }

  const service: CatalogEntry = {
    id: domainSlug(domain),
    name: domain,
    domain,
    description,
    icon: undefined,
    categories: [],
    popularity: 0,
    featuredAt: undefined,
    standalone: false,
    sources,
  };

  return { service, refused };
});

/** What integrations.sh's failure means for the caller: wait (`429`), or it could not be read. */
const failure = (via: LookupVia) => (error: { readonly status?: number }) =>
  new LookupError(
    error.status === 429
      ? { reason: "rate_limited", message: `integrations.sh asks to wait before the next ${via}` }
      : { reason: "failed", message: `integrations.sh's ${via} could not be read` },
  );

/**
 * `domain` looked up at integrations.sh (`via`): its answer as a service for one toolkit, with the source URLs the
 * outbound guard refuses left out.
 */
export const lookupDomain = Effect.fnUntraced(function* (domain: CheckedDomain, via: LookupVia) {
  const text = yield* fetchDocument(
    `${INTEGRATIONS_SH_API}/${encodeURIComponent(domain)}/${via}`,
    via === "detect" ? DETECT_TIMEOUT : DISCOVER_TIMEOUT,
  ).pipe(Effect.mapError(failure(via)));

  const unreadable = () =>
    new LookupError({ reason: "failed", message: `integrations.sh's ${via} could not be read` });

  const { found, description } =
    via === "detect"
      ? {
          found: detectedSources(yield* Effect.mapError(decodeDetection(text), unreadable)),
          description: undefined,
        }
      : yield* Effect.map(Effect.mapError(decodeDiscovery(text), unreadable), (discovery) => ({
          found: discoveredSources(discovery),
          description: discovery.description ?? discovery.summary ?? undefined,
        }));

  const { service, refused } = yield* proposalOf(domain, found, description);

  return {
    via,
    service: serviceView(service, false),
    ...(refused.length === 0 ? {} : { refused }),
  } satisfies DomainLookup;
});
