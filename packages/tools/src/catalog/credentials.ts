/**
 * How integrations.sh describes signing in to a source, as the toolkit catalog's credential types (`CatalogAuth`,
 * integrations.sh's own names, which map onto toolkit credentials directly, `catalog.ts` `credentialOf`).
 *
 * Two shapes come in. Its index (`api.json`, the catalog's registry) records a curated surface's credential `kind`
 * (`none`, `oauth`, `api_key`, `token`, `mixed`) and the header pattern a key goes in (`Authorization: Bearer {token}`,
 * `X-Figma-Token: {token}`; Linear's `Authorization: {api_key}` takes no prefix). Its discovery model (v3: a domain's
 * `/api/<domain>/surface` document, the answer of `discover` and of a domain's own `integrations.json`) names each
 * credential's `type` and, per surface, its `mechanics`: where it goes (`http`: a header or the query, with its name and
 * scheme) or how it is negotiated (`well-known`: MCP OAuth). Request signing (`signature`) and `custom` schemes need
 * code per service: they are left out.
 *
 * The sync script (`bun run toolkits:sync`) reads the v3 documents of the catalog's domains through this module (as
 * `@commissary/tools/integrations-sh-credentials`) into the bundled credentials (`integrations-sh-credentials.json`,
 * {@link CatalogCredentials}), so it imports nothing but `effect`; the domain lookup (`lookup.ts`) reads `discover`'s
 * answers with it too.
 */
import { Result, Schema } from "effect";

const optional = Schema.optionalKey;

/** integrations.sh's credential types (its discovery model's `credentials[].type`) that Commissary can use. */
export const CredentialType = Schema.Literals([
  "none",
  "api_key",
  "basic",
  "bearer",
  "oauth2",
  "oauth2_cc",
  "oauth1",
  "tba",
  "jwt",
  "app",
  "two_step",
  "aws_sigv4",
  "compound",
]);

export type CredentialType = typeof CredentialType.Type;

/** One way to sign in to a source: a credential type and, for a key, where it goes. */
export const CatalogAuth = Schema.Struct({
  type: CredentialType,
  /** A key's place: a header (the default) or the query. */
  in: optional(Schema.Literals(["header", "query"])),
  /** The header or query parameter. */
  name: optional(Schema.String),
  /** What goes before the key in its header (`Token`). */
  prefix: optional(Schema.String),
});

export type CatalogAuth = typeof CatalogAuth.Type;

/**
 * The bundled credentials (`integrations-sh-credentials.json`): the ways each source of the registry takes, by the
 * index's slug, from the v3 document of its domain. A source without an entry has only what the index says.
 */
export const CatalogCredentials = Schema.Struct({
  version: Schema.Literal(1),
  sources: Schema.Record(Schema.String, Schema.Array(CatalogAuth)),
});

export type CatalogCredentials = typeof CatalogCredentials.Type;

/** `Authorization: Bearer {token}` and its kin: the header, and what comes before the placeholder. */
const HEADER_PATTERN = /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*(.*?)\s*\{[^}]*\}\s*$/;

/** The credential a header pattern describes: a bearer token, basic auth, or a key in a named header. */
export const headerAuth = (pattern: string): CatalogAuth | undefined => {
  const match = HEADER_PATTERN.exec(pattern);

  if (match === null) return undefined;
  const name = match[1] ?? "";
  const prefix = (match[2] ?? "").trim();
  const authorization = name.toLowerCase() === "authorization";

  if (authorization && prefix.toLowerCase() === "bearer") return { type: "bearer" };

  if (authorization && prefix.toLowerCase() === "basic") return { type: "basic" };

  return { type: "api_key", in: "header", name, ...(prefix === "" ? {} : { prefix }) };
};

/** The ways the index says a surface takes, any one of them; empty when it does not say. */
export const indexAuth = (
  auth: { readonly kind?: string; readonly header?: string } | undefined,
): ReadonlyArray<CatalogAuth> => {
  const key = auth?.header === undefined ? undefined : headerAuth(auth.header);

  switch (auth?.kind) {
    case "none":
      return [{ type: "none" }];
    case "oauth":
      return [{ type: "oauth2" }];
    case "api_key":
      return [key ?? { type: "api_key" }];
    case "token":
      return [key ?? { type: "bearer" }];
    case "mixed":
      return key === undefined ? [{ type: "oauth2" }] : [{ type: "oauth2" }, key];
    default:
      return key === undefined ? [] : [key];
  }
};

/** How integrations.sh's discovery model says one credential is placed on a surface (`mechanics`). */
const Mechanics = Schema.Struct({
  source: optional(Schema.String),
  in: optional(Schema.String),
  headerName: optional(Schema.String),
  scheme: optional(Schema.String),
  paramName: optional(Schema.String),
});

export type Mechanics = typeof Mechanics.Type;

/** integrations.sh's v3 credential types and the catalog's: the same names, but `signature` and `custom`. */
const isCredentialType = Schema.is(CredentialType);

/**
 * One v3 credential of `type` placed as `mechanics` says, as a catalog credential; undefined for a type Commissary
 * cannot run from data alone (`signature`, `custom`). A key in the `query` names its parameter; a bearer token or a key
 * in a header named something other than `Authorization: Bearer` is a key in that header, with its scheme as prefix.
 */
export const discoveryAuth = (type: string, mechanics: Mechanics): CatalogAuth | undefined => {
  if (!isCredentialType(type)) return undefined;

  if (type !== "api_key" && type !== "bearer") return { type };

  if (mechanics.source !== "http") return { type };

  if (mechanics.in === "query")
    return {
      type: "api_key",
      in: "query",
      ...(mechanics.paramName === undefined ? {} : { name: mechanics.paramName }),
    };
  const name = mechanics.headerName ?? "Authorization";
  const scheme = mechanics.scheme?.trim() ?? "";

  if (name.toLowerCase() === "authorization" && scheme.toLowerCase() === "bearer")
    return { type: "bearer" };

  if (name.toLowerCase() === "authorization" && scheme === "" && type === "bearer")
    return { type: "bearer" };

  return { type: "api_key", in: "header", name, ...(scheme === "" ? {} : { prefix: scheme }) };
};

const AuthStatus = Schema.Struct({
  status: Schema.String,
  entries: optional(
    Schema.Array(
      Schema.Struct({
        use: Schema.Array(Schema.Struct({ id: Schema.String, mechanics: optional(Mechanics) })),
      }),
    ),
  ),
});

const Surface = Schema.Struct({
  type: Schema.String,
  slug: optional(Schema.String),
  name: optional(Schema.String),
  url: optional(Schema.NullOr(Schema.String)),
  spec: optional(Schema.NullOr(Schema.String)),
  specAlternates: optional(Schema.NullOr(Schema.Array(Schema.String))),
  auth: optional(AuthStatus),
});

/** integrations.sh's discovery model (v3), as much of it as a toolkit needs. */
export const Discovery = Schema.Struct({
  summary: optional(Schema.NullOr(Schema.String)),
  description: optional(Schema.NullOr(Schema.String)),
  credentials: optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Struct({ type: Schema.String }))),
  ),
  surfaces: optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

export type Discovery = typeof Discovery.Type;

/** The kinds of source a v3 surface can be: an HTTP API is an OpenAPI source; a CLI is none. */
export type SurfaceKind = "mcp" | "openapi" | "graphql";

/** A v3 surface a toolkit can be built from: what it is built from, and the ways it takes. */
export interface DiscoveredSurface {
  readonly kind: SurfaceKind;
  readonly slug: string | undefined;
  readonly name: string | undefined;
  /** What a toolkit is built from: an MCP server's or GraphQL endpoint's URL, an HTTP API's OpenAPI document. */
  readonly url: string;
  /** The same document in other formats (an HTTP API's YAML twin), which name the same source. */
  readonly alternates: ReadonlyArray<string>;
  /** The ways it takes, any one of them; empty when the document does not say. */
  readonly auth: ReadonlyArray<CatalogAuth>;
}

const decodeSurface = Schema.decodeUnknownResult(Surface);

/** The ways a v3 surface takes, any one of them: a way that needs several credentials together is left out. */
const surfaceAuth = (
  auth: typeof AuthStatus.Type | undefined,
  credentials: Readonly<Record<string, { readonly type: string }>>,
): ReadonlyArray<CatalogAuth> => {
  if (auth?.status === "none") return [{ type: "none" }];

  return (auth?.entries ?? []).flatMap((entry) => {
    const [use, ...more] = entry.use;
    const type = use === undefined ? undefined : credentials[use.id]?.type;

    if (use === undefined || more.length > 0 || type === undefined) return [];
    const mapped = discoveryAuth(type, use.mechanics ?? {});

    return mapped === undefined ? [] : [mapped];
  });
};

const surfaceKind = (type: string): SurfaceKind | undefined => {
  switch (type) {
    case "http":
      return "openapi";
    case "graphql":
      return "graphql";
    case "mcp":
      return "mcp";
    default:
      return undefined;
  }
};

/** The surfaces of a v3 document a toolkit can be built from; one that does not decode is skipped. */
export const discoveredSurfaces = (result: Discovery): ReadonlyArray<DiscoveredSurface> => {
  const credentials = result.credentials ?? {};

  return (result.surfaces ?? []).flatMap((entry): ReadonlyArray<DiscoveredSurface> => {
    const surface = decodeSurface(entry);

    if (Result.isFailure(surface)) return [];
    const { type, slug, name, url, spec, specAlternates, auth } = surface.success;
    const kind = surfaceKind(type);
    // An HTTP API is built from its OpenAPI document; one without (or a GraphQL schema's `introspection`) has none.
    const locator = type === "http" ? spec : url;

    if (kind === undefined || locator === undefined || locator === null) return [];

    return [
      {
        kind,
        slug,
        name,
        url: locator,
        alternates: type === "http" ? (specAlternates ?? []) : [],
        auth: surfaceAuth(auth, credentials),
      },
    ];
  });
};

/** A URL as sources are matched by: without a trailing slash, its scheme and host in lowercase. */
export const matchableUrl = (url: string): string => {
  const trimmed = url.trim();

  if (!URL.canParse(trimmed)) return trimmed;
  const parsed = new URL(trimmed);

  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
};

const decodeDiscovery = Schema.decodeUnknownResult(Schema.fromJsonString(Discovery));

/** A v3 document's text (as `/api/<domain>/surface` answers it) read; undefined when it is not one. */
export const discoveryFromText = (text: string): Discovery | undefined => {
  const decoded = decodeDiscovery(text);

  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

/**
 * The ways each of `sources` takes by the v3 document of their domain, by slug: a source matches the surface of its kind
 * whose URL (or an alternate's) is its own. A source that matches none, or whose surface does not say, is left out.
 */
export const sourceCredentials = (
  document: Discovery,
  sources: ReadonlyArray<{
    readonly slug: string;
    readonly kind: string;
    readonly connectUrl: string;
  }>,
): ReadonlyMap<string, ReadonlyArray<CatalogAuth>> => {
  const byUrl = new Map<string, DiscoveredSurface>();

  for (const surface of discoveredSurfaces(document))
    for (const url of [surface.url, ...surface.alternates]) {
      const key = `${surface.kind} ${matchableUrl(url)}`;

      if (!byUrl.has(key) && surface.auth.length > 0) byUrl.set(key, surface);
    }

  return new Map(
    sources.flatMap((source) => {
      const surface = byUrl.get(`${source.kind} ${matchableUrl(source.connectUrl)}`);

      return surface === undefined ? [] : [[source.slug, surface.auth] as const];
    }),
  );
};
