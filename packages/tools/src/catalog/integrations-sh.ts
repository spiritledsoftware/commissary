/**
 * integrations.sh's index (`https://integrations.sh/api.json`, MIT, UsefulSoftwareCo; ≈2.8 MB, one record per surface
 * of every service it lists) trimmed to what the toolkit catalog reads (ADR 0036, #207): the MCP servers, OpenAPI
 * documents and GraphQL endpoints Commissary can build a toolkit from, with only the fields it uses. CLIs go, and so
 * does a surface with nothing to build from: no machine-readable locator (`connectUrl`: a REST API without a spec), or
 * one that is not a public `https:` URL (a stdio command, a host with a placeholder, plain `http:`).
 *
 * The index is integrations.sh's one bulk export; its per-domain documents (`/api/<domain>/surface`, the v3 discovery
 * model with a credential registry) are read only live, by `detect` and `discover` (`lookup.ts`). See
 * docs/ARCHITECTURE.md, "Toolkit catalog".
 *
 * Shared by the sync script (`bun run toolkits:sync`, run by Node directly, so this module imports nothing but
 * `effect`; it imports it as `@commissary/tools/integrations-sh`) and by the cron refresh (`refresh.ts`). The output
 * keeps the index's shape (`{ version: 1, data }`) with the kept records and fields sorted, so trimming a trimmed
 * document gives it back unchanged and the runtime reads both. A malformed record is skipped and counted (`skipped`); a
 * document that is not the index, or that keeps fewer sources than `minimum`, is rejected, so a broken upstream
 * document never replaces a good one.
 */
import { Result, Schema } from "effect";
import { JsonPatchOperation } from "../openapi/patch.ts";

/** Where integrations.sh's index is. */
export const INTEGRATIONS_SH_INDEX_URL = "https://integrations.sh/api.json";

/** The fewest buildable sources a document must keep to be taken (the index keeps ≈3,700). */
export const MIN_SOURCES = 1000;

const optional = Schema.optionalKey;

/** The surface kinds a toolkit can be built from: the index's other kind is `cli`. */
const BuildableKind = Schema.Literals(["mcp", "openapi", "graphql"]);

export type BuildableKind = typeof BuildableKind.Type;

/**
 * A surface's credential as the index records it, on its curated records only: `kind` (`none`, `oauth`, `api_key`,
 * `token`, `mixed`) and the header the key goes in, a pattern such as `Authorization: Bearer {token}`.
 */
const IndexAuth = Schema.Struct({
  kind: optional(Schema.NullOr(Schema.String)),
  header: optional(Schema.NullOr(Schema.String)),
});

/** One record of the index, as it is read: every field Commissary does not use is dropped. */
const IndexRecord = Schema.Struct({
  kind: Schema.String,
  slug: Schema.NonEmptyString,
  name: Schema.String,
  domain: Schema.NonEmptyString,
  description: optional(Schema.NullOr(Schema.String)),
  icon: optional(Schema.NullOr(Schema.String)),
  categories: optional(Schema.NullOr(Schema.Array(Schema.String))),
  popularity: optional(Schema.NullOr(Schema.Finite)),
  standalone: optional(Schema.NullOr(Schema.Boolean)),
  connectUrl: optional(Schema.NullOr(Schema.String)),
  auth: optional(Schema.NullOr(IndexAuth)),
  scopes: optional(Schema.NullOr(Schema.Array(Schema.String))),
  specOverrides: optional(Schema.NullOr(Schema.Array(JsonPatchOperation))),
});

const Envelope = Schema.Struct({ version: Schema.Literal(1), data: Schema.Array(Schema.Unknown) });

/** A kept record: a buildable surface of one service (its `domain`; a `standalone` product on a shared domain). */
export interface RegistrySource {
  readonly kind: BuildableKind;
  /** integrations.sh's stable identifier of the surface. */
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly domain: string;
  readonly categories?: ReadonlyArray<string>;
  readonly popularity?: number;
  /** A product of its own on a shared domain (Outlook Mail on `graph.microsoft.com`): a service of its own. */
  readonly standalone?: true;
  /** What a toolkit is built from: the MCP server's URL, the OpenAPI document's, the GraphQL endpoint's. */
  readonly connectUrl: string;
  readonly auth?: { readonly kind?: string; readonly header?: string };
  /** The OAuth scopes the surface needs. */
  readonly scopes?: ReadonlyArray<string>;
  /**
   * integrations.sh's fixes to an OpenAPI document (RFC 6902 JSON Patch operations: a wrong authorization URL, missing
   * scopes), applied to the document when a toolkit added from the source builds its tools.
   */
  readonly specOverrides?: ReadonlyArray<JsonPatchOperation>;
}

/** The trimmed index: what ships as `catalog/integrations-sh.json` and what the cron refresh stores in KV. */
export interface TrimmedRegistry {
  readonly version: 1;
  readonly data: ReadonlyArray<RegistrySource>;
}

export type Trimmed =
  | {
      readonly ok: true;
      readonly value: TrimmedRegistry;
      /** Records that did not decode and were left out. */
      readonly skipped: number;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Whether `url` is one the catalog keeps: an `https:` URL without a placeholder or spaces (a toolkit's source, a
 * lookup's answer, an icon). It still passes the outbound guard where it is fetched.
 */
export const buildableUrl = (url: string): boolean =>
  !/[{}<>\s]/.test(url) && URL.canParse(url) && new URL(url).protocol === "https:";

const parseEnvelope = Schema.decodeUnknownResult(Schema.fromJsonString(Envelope));

const decodeEnvelope = Schema.decodeUnknownResult(Envelope);

const decodeRecord = Schema.decodeUnknownResult(IndexRecord);

const nonEmpty = (value: string | null | undefined): string | undefined =>
  value === null || value === undefined || value.trim() === "" ? undefined : value;

/** `record` as it is kept, or undefined when Commissary cannot build a toolkit from it. */
const kept = (record: typeof IndexRecord.Type): RegistrySource | undefined => {
  if (!Schema.is(BuildableKind)(record.kind)) return undefined;
  const connectUrl = nonEmpty(record.connectUrl)?.trim();

  if (connectUrl === undefined || !buildableUrl(connectUrl)) return undefined;
  const description = nonEmpty(record.description);
  // Only an `https:` icon is kept: the panel shows it as an image the browser loads (an icon proxy, if one comes,
  // fetches through the outbound guard).
  const icon = nonEmpty(record.icon)?.trim();
  const authKind = nonEmpty(record.auth?.kind);
  const header = nonEmpty(record.auth?.header);
  const categories = record.categories ?? [];
  const scopes = record.scopes ?? [];

  return {
    kind: record.kind,
    slug: record.slug,
    name: record.name,
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined || !buildableUrl(icon) ? {} : { icon }),
    domain: record.domain.trim().toLowerCase(),
    ...(categories.length === 0 ? {} : { categories }),
    ...(record.popularity === null || record.popularity === undefined
      ? {}
      : { popularity: record.popularity }),
    ...(record.standalone === true ? { standalone: true } : {}),
    connectUrl,
    ...(authKind === undefined && header === undefined
      ? {}
      : {
          auth: {
            ...(authKind === undefined ? {} : { kind: authKind }),
            ...(header === undefined ? {} : { header }),
          },
        }),
    ...(scopes.length === 0 ? {} : { scopes }),
    ...(record.kind === "openapi" && (record.specOverrides?.length ?? 0) > 0
      ? { specOverrides: record.specOverrides ?? [] }
      : {}),
  };
};

const order = (a: RegistrySource, b: RegistrySource): number =>
  a.domain === b.domain
    ? a.slug < b.slug
      ? -1
      : a.slug > b.slug
        ? 1
        : 0
    : a.domain < b.domain
      ? -1
      : 1;

const NOT_THE_INDEX = "the document is not integrations.sh's index (version 1)";

/** The kept records of a decoded envelope, or why there are too few. */
const trimmed = (entries: ReadonlyArray<unknown>, minimum: number): Trimmed => {
  let skipped = 0;
  const data: Array<RegistrySource> = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const record = decodeRecord(entry);

    if (Result.isFailure(record)) {
      skipped += 1;
      continue;
    }

    const source = kept(record.success);

    // The first record of a slug wins: it is the surface's identifier.
    if (source === undefined || seen.has(source.slug)) continue;
    seen.add(source.slug);
    data.push(source);
  }

  if (data.length < minimum)
    return {
      ok: false,
      error: `the registry lists ${data.length} sources Commissary can build, fewer than ${minimum}`,
    };

  return { ok: true, value: { version: 1, data: data.toSorted(order) }, skipped };
};

/** Trims integrations.sh's index text (or a trimmed document) to the toolkit catalog's registry. */
export const trimIntegrationsSh = (
  text: string,
  options: { readonly minimum?: number } = {},
): Trimmed => {
  const envelope = parseEnvelope(text);

  return Result.isFailure(envelope)
    ? { ok: false, error: NOT_THE_INDEX }
    : trimmed(envelope.success.data, options.minimum ?? MIN_SOURCES);
};

/** A stored trimmed registry, read without the minimum (it was checked when it was stored). */
export const registryFromText = (text: string): Trimmed => trimIntegrationsSh(text, { minimum: 1 });

/**
 * The bundled snapshot (parsed JSON), read through the same trim as a refreshed copy, so a hand-edited or stale
 * snapshot that does not decode is caught rather than cast.
 */
export const registryFromJson = (json: Schema.Json): Trimmed => {
  const envelope = decodeEnvelope(json);

  return Result.isFailure(envelope)
    ? { ok: false, error: NOT_THE_INDEX }
    : trimmed(envelope.success.data, 1);
};
