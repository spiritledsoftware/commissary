/**
 * The toolkit catalog (ADR 0036, #207): integrations.sh's trimmed registry (`integrations-sh.ts`, the KV copy the cron
 * task refreshes or the bundled snapshot) grouped into services, merged with the toolkit catalog additions
 * (`additions.ts`), and searched.
 *
 * A service is a domain of the registry, or a product integrations.sh marks `standalone` on a shared domain (Outlook
 * Mail on `graph.microsoft.com`); its sources are the domain's MCP servers, OpenAPI documents and GraphQL endpoints. Its
 * id is its catalog slug, the default name of a toolkit added from it (ADR 0037): the domain's own label as
 * `defaultToolkitName` reads a host (`linear.app` → `linear`), or a standalone product's name (`outlook_mail`). Of
 * services whose slugs clash, the one with the shortest domain keeps it, and the others take their whole domain's
 * (`linear_com`); an addition names a service by its slug.
 *
 * The additions fill gaps (a service or source the registry lacks, a missing description or icon) and the registry
 * wins over them where it has a value; corrections win over the registry.
 */
import type {
  CatalogCredential,
  CatalogService,
  CatalogServiceSummary,
  CatalogSource,
} from "@commissary/contract/toolkit-catalog";
import type { CredentialSettings, ToolkitCredentialKind } from "@commissary/contract/tools";
import { toolkitNameOf } from "../toolkits/names.ts";
import { Result, Schema } from "effect";
import { type Additions, type CatalogSourceKind, bundledAdditions } from "./additions.ts";
import { type CatalogAuth, CatalogCredentials, indexAuth } from "./credentials.ts";
import credentialsJson from "./integrations-sh-credentials.json";
import { domainSlug } from "./slugs.ts";
import snapshot from "./integrations-sh.json";
import { type RegistrySource, type TrimmedRegistry, registryFromJson } from "./integrations-sh.ts";
import type { JsonPatchOperation } from "../openapi/patch.ts";

/** One source of a catalog service, as the catalog keeps it. */
export interface CatalogEntrySource {
  readonly id: string;
  readonly kind: CatalogSourceKind;
  readonly name: string;
  readonly url: string;
  /** The ways to sign in, any one of them; empty: not known. */
  readonly auth: ReadonlyArray<CatalogAuth>;
  readonly scopes: ReadonlyArray<string> | undefined;
  readonly credentialSettings: CredentialSettings | undefined;
  /** integrations.sh's fixes to an OpenAPI source's document, applied when a toolkit added from it builds its tools. */
  readonly specPatch: ReadonlyArray<JsonPatchOperation> | undefined;
  /** A correction of the additions changed it. */
  readonly corrected: boolean;
}

/** A catalog service, as the catalog keeps it. */
export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly description: string | undefined;
  readonly icon: string | undefined;
  readonly categories: ReadonlyArray<string>;
  readonly popularity: number;
  /** Its place on the featured list; undefined: not featured. */
  readonly featuredAt: number | undefined;
  /** A product of its own on a shared domain: a domain lookup does not find it. */
  readonly standalone: boolean;
  readonly sources: ReadonlyArray<CatalogEntrySource>;
}

export interface CatalogQuery {
  readonly q?: string | undefined;
  readonly kind?: CatalogSourceKind | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export const DEFAULT_PAGE = 50;

export const MAX_PAGE = 200;

export interface Catalog {
  /** Featured first (in the additions' order), then by popularity, then by slug. */
  readonly services: ReadonlyArray<CatalogEntry>;
  readonly service: (id: string) => CatalogEntry | undefined;
  /** The service of `domain`, or of the nearest domain above it (`mcp.linear.app` → `linear.app`). */
  readonly forDomain: (domain: string) => CatalogEntry | undefined;
  readonly search: (query: CatalogQuery) => {
    readonly services: ReadonlyArray<CatalogEntry>;
    readonly total: number;
  };
}

/** What a group of records becomes: one service, before its slug is chosen. */
interface Group {
  readonly key: string;
  readonly domain: string;
  readonly standalone: boolean;
  readonly records: Array<RegistrySource>;
}

const popularityOf = (record: RegistrySource): number => record.popularity ?? 0;

const byPopularity = (a: RegistrySource, b: RegistrySource): number =>
  popularityOf(b) - popularityOf(a) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/** Each group's slug: its own when no other group wants it, else the shortest domain keeps it. */
const slugsOf = (groups: ReadonlyArray<Group>): ReadonlyMap<string, string> => {
  const wanted = new Map<string, Array<Group>>();

  for (const group of groups) {
    const base = group.standalone
      ? toolkitNameOf(group.records[0]?.name ?? group.domain)
      : domainSlug(group.domain);

    wanted.set(base, [...(wanted.get(base) ?? []), group]);
  }

  const slugs = new Map<string, string>();
  const taken = new Set(wanted.keys());

  for (const [base, claimants] of wanted) {
    const ordered = claimants.toSorted(
      (a, b) =>
        Number(a.standalone) - Number(b.standalone) ||
        a.domain.length - b.domain.length ||
        (a.key < b.key ? -1 : 1),
    );

    ordered.forEach((group, index) => {
      if (index === 0) {
        slugs.set(group.key, base);

        return;
      }

      let slug = toolkitNameOf(
        group.standalone ? `${group.records[0]?.name ?? ""} ${group.domain}` : group.domain,
      );

      for (let n = 2; taken.has(slug); n++) slug = toolkitNameOf(`${slug} ${n}`);
      taken.add(slug);
      slugs.set(group.key, slug);
    });
  }

  return slugs;
};

/** The ways each registry source takes, by slug, from its domain's v3 document (`credentials.ts`). */
type SourceCredentials = CatalogCredentials["sources"];

const registrySource =
  (credentials: SourceCredentials) =>
  (record: RegistrySource): CatalogEntrySource => ({
    id: record.slug,
    kind: record.kind,
    name: record.name,
    url: record.connectUrl,
    // The v3 document's credential registry says more (where a key goes, the types beyond the index's five); the
    // index's own note is the fallback.
    auth: Object.hasOwn(credentials, record.slug)
      ? (credentials[record.slug] ?? [])
      : indexAuth(record.auth),
    scopes: record.scopes,
    credentialSettings: undefined,
    specPatch: record.specOverrides,
    corrected: false,
  });

const KIND_ORDER: Readonly<Record<CatalogSourceKind, number>> = {
  mcp: 0,
  openapi: 1,
  graphql: 2,
  discovery: 3,
};

const serviceOf = (group: Group, id: string, credentials: SourceCredentials): CatalogEntry => {
  const records = group.records.toSorted(byPopularity);
  const first = records[0];
  const categories = [...new Set(records.flatMap((record) => record.categories ?? []))];

  return {
    id,
    name: first?.name ?? id,
    domain: group.domain,
    description: records.find((record) => record.description !== undefined)?.description,
    icon: records.find((record) => record.icon !== undefined)?.icon,
    categories,
    popularity: Math.max(0, ...records.map(popularityOf)),
    featuredAt: undefined,
    standalone: group.standalone,
    sources: records
      .map(registrySource(credentials))
      .toSorted((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]),
  };
};

const additionSource = (
  source: Additions["services"][number]["sources"][number],
): CatalogEntrySource => ({
  id: source.id,
  kind: source.kind,
  name: source.name,
  url: source.url,
  auth: source.auth ?? [],
  scopes: source.scopes,
  credentialSettings: source.credential_settings,
  specPatch: undefined,
  corrected: false,
});

/** `services` with the additions' services and sources, gaps filled, and corrections applied. */
const withAdditions = (
  services: ReadonlyArray<CatalogEntry>,
  additions: Additions,
): ReadonlyArray<CatalogEntry> => {
  const byId = new Map(services.map((service) => [service.id, service]));

  for (const addition of additions.services) {
    const existing = byId.get(addition.id);

    if (existing === undefined) {
      if (addition.name === undefined || addition.domain === undefined) continue;
      byId.set(addition.id, {
        id: addition.id,
        name: addition.name,
        domain: addition.domain,
        description: addition.description,
        icon: addition.icon,
        categories: addition.categories ?? [],
        popularity: 0,
        featuredAt: undefined,
        standalone: false,
        sources: addition.sources.map(additionSource),
      });
      continue;
    }

    const ids = new Set(existing.sources.map((source) => source.id));

    byId.set(addition.id, {
      ...existing,
      description: existing.description ?? addition.description,
      icon: existing.icon ?? addition.icon,
      categories:
        existing.categories.length > 0 ? existing.categories : (addition.categories ?? []),
      sources: [
        ...existing.sources,
        ...addition.sources.filter((source) => !ids.has(source.id)).map(additionSource),
      ],
    });
  }

  for (const correction of additions.corrections) {
    const service = byId.get(correction.service);

    if (service === undefined) continue;
    byId.set(service.id, {
      ...service,
      sources: service.sources.map((source) =>
        source.id === correction.source
          ? {
              ...source,
              kind: correction.kind ?? source.kind,
              url: correction.url ?? source.url,
              auth: correction.auth ?? source.auth,
              scopes: correction.scopes ?? source.scopes,
              credentialSettings: correction.credential_settings ?? source.credentialSettings,
              corrected: true,
            }
          : source,
      ),
    });
  }

  const featured = new Map(additions.featured.map((id, index) => [id, index]));

  return [...byId.values()].map((service) => ({
    ...service,
    featuredAt: featured.get(service.id),
  }));
};

const listOrder = (a: CatalogEntry, b: CatalogEntry): number =>
  (a.featuredAt ?? Infinity) - (b.featuredAt ?? Infinity) ||
  b.popularity - a.popularity ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const haystackOf = (service: CatalogEntry): string =>
  [service.id, service.name, service.domain, service.description ?? "", ...service.categories]
    .join(" ")
    .toLowerCase();

const clampPage = (value: number | undefined, fallback: number, max: number): number =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(max, Math.max(0, Math.trunc(value)));

/** The catalog of `registry` with `additions`, its sources' credentials from `credentials` where it has them. */
export const buildCatalog = (
  registry: TrimmedRegistry,
  additions: Additions,
  credentials: SourceCredentials = bundledCredentials(),
): Catalog => {
  const groups = new Map<string, Group>();

  for (const record of registry.data) {
    const key = record.standalone === true ? `standalone:${record.slug}` : record.domain;
    const group = groups.get(key);

    if (group === undefined)
      groups.set(key, {
        key,
        domain: record.domain,
        standalone: record.standalone === true,
        records: [record],
      });
    else group.records.push(record);
  }

  const slugs = slugsOf([...groups.values()]);

  const services = withAdditions(
    [...groups.values()].map((group) =>
      serviceOf(group, slugs.get(group.key) ?? group.key, credentials),
    ),
    additions,
  ).toSorted(listOrder);

  const byId = new Map(services.map((service) => [service.id, service]));

  const byDomain = new Map(
    services
      .filter((service) => !service.standalone)
      .map((service) => [service.domain, service] as const),
  );

  const haystacks = new Map(services.map((service) => [service.id, haystackOf(service)]));

  return {
    services,
    service: (id) => byId.get(id),
    forDomain: (domain) => {
      const labels = domain.trim().toLowerCase().replace(/\.$/, "").split(".");

      for (let start = 0; start < labels.length - 1; start++) {
        const found = byDomain.get(labels.slice(start).join("."));

        if (found !== undefined) return found;
      }

      return undefined;
    },
    search: (query) => {
      const words = (query.q ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word !== "");

      const matching = services.filter(
        (service) =>
          (query.kind === undefined ||
            service.sources.some((source) => source.kind === query.kind)) &&
          words.every((word) => haystacks.get(service.id)?.includes(word) === true),
      );

      const offset = clampPage(query.offset, 0, Number.MAX_SAFE_INTEGER);
      const limit = clampPage(query.limit, DEFAULT_PAGE, MAX_PAGE);

      return { services: matching.slice(offset, offset + limit), total: matching.length };
    },
  };
};

let embeddedCredentials: SourceCredentials | undefined;

/** The bundled credentials (`integrations-sh-credentials.json`, `pnpm toolkits:sync`), decoded once per isolate. */
export const bundledCredentials = (): SourceCredentials => {
  if (embeddedCredentials === undefined) {
    const decoded = Schema.decodeUnknownResult(CatalogCredentials)(credentialsJson);

    if (Result.isFailure(decoded))
      throw new Error(
        `bundled integrations-sh-credentials.json is invalid: ${decoded.failure.message}`,
      );
    embeddedCredentials = decoded.success.sources;
  }

  return embeddedCredentials;
};

let embedded: Catalog | undefined;

/** The catalog of the bundled snapshot with the bundled additions, built once per isolate. */
export const embeddedCatalog = (): Catalog => {
  if (embedded === undefined) {
    const registry = registryFromJson(snapshot);

    if (!registry.ok) throw new Error(`bundled integrations-sh.json is invalid: ${registry.error}`);
    embedded = buildCatalog(registry.value, bundledAdditions());
  }

  return embedded;
};

// --- views ---------------------------------------------------------------------------------------------------------

/** The toolkit credential kind each integrations.sh credential type is. */
const CREDENTIAL_KIND: Readonly<Record<CatalogAuth["type"], ToolkitCredentialKind>> = {
  none: "none",
  api_key: "header",
  basic: "basic",
  bearer: "bearer",
  oauth2: "oauth",
  oauth2_cc: "client_credentials",
  oauth1: "oauth1",
  tba: "tba",
  jwt: "jwt",
  app: "app",
  two_step: "token_exchange",
  aws_sigv4: "aws_sigv4",
  compound: "compound",
};

/** `auth` as a toolkit credential: an API key in the query is a `query` key, anywhere else a `header` one. */
export const credentialOf = (auth: CatalogAuth): CatalogCredential => {
  const kind: ToolkitCredentialKind =
    auth.type === "api_key" && auth.in === "query" ? "query" : CREDENTIAL_KIND[auth.type];

  return {
    kind,
    ...(auth.name === undefined || (kind !== "header" && kind !== "query")
      ? {}
      : { name: auth.name }),
    ...(auth.prefix === undefined || kind !== "header" ? {} : { prefix: auth.prefix }),
  };
};

/** The toolkit credentials of `auth`, each once. */
export const credentialsOf = (
  auth: ReadonlyArray<CatalogAuth>,
): ReadonlyArray<CatalogCredential> => {
  const seen = new Set<string>();

  return auth.flatMap((way) => {
    const credential = credentialOf(way);
    const key = JSON.stringify(credential);

    if (seen.has(key)) return [];
    seen.add(key);

    return [credential];
  });
};

/** Whether a source's sign-ins would use a managed OAuth app: one of its credentials is an `oauth` sign-in. */
const signsIn = (source: CatalogEntrySource): boolean =>
  source.auth.some((auth) => auth.type === "oauth2");

export const sourceView = (source: CatalogEntrySource, managedApp: boolean): CatalogSource => ({
  id: source.id,
  kind: source.kind,
  name: source.name,
  url: source.url,
  credentials: credentialsOf(source.auth),
  ...(source.credentialSettings === undefined
    ? {}
    : { credential_settings: source.credentialSettings }),
  ...(source.scopes === undefined || source.scopes.length === 0 ? {} : { scopes: source.scopes }),
  ...(managedApp && signsIn(source) ? { managed_oauth_app: true } : {}),
  ...(source.corrected ? { corrected: true } : {}),
});

export const summaryView = (service: CatalogEntry): CatalogServiceSummary => ({
  id: service.id,
  name: service.name,
  domain: service.domain,
  ...(service.description === undefined ? {} : { description: service.description }),
  ...(service.icon === undefined ? {} : { icon: service.icon }),
  categories: service.categories,
  featured: service.featuredAt !== undefined,
  kinds: [...new Set(service.sources.map((source) => source.kind))],
});

/** `service` as the API answers it; `managedApp`: whether Commissary Cloud's OAuth app with it is available. */
export const serviceView = (service: CatalogEntry, managedApp: boolean): CatalogService => ({
  ...summaryView(service),
  sources: service.sources.map((source) => sourceView(source, managedApp)),
});
