// Adding a toolkit (#208, ADR 0036, #207, docs/ARCHITECTURE.md "Toolkit catalog"): from a service and source of the
// toolkit catalog, from what a domain looks up to (the catalog's service, or integrations.sh's `detect` or `discover`),
// from a URL as it was typed, or from an uploaded document; with the name and credentials it is added with. The body of
// `POST /toolkits` for each. Pure: no DOM, tested in test/toolkit-add.test.ts.
import type {
  CatalogService,
  CatalogSource,
  DomainLookup,
} from "@commissary/contract/toolkit-catalog";
import type {
  AddedToolkitKind,
  AddToolkit,
  CredentialsAccepted,
  ToolkitCredentialKind,
} from "@commissary/contract/tools";

/** Where a new toolkit comes from. */
export type AddOrigin =
  | {
      readonly from: "catalog";
      readonly service: CatalogService;
      readonly source: CatalogSource;
    }
  | { readonly from: "lookup"; readonly lookup: DomainLookup; readonly source: CatalogSource }
  | { readonly from: "url"; readonly url: string; readonly kind: AddedToolkitKind }
  | { readonly from: "upload"; readonly kind: AddedToolkitKind; readonly document: string };

/** What the person chooses about it: its name, whose it is and which credentials it accepts. */
export interface AddDetails {
  /** Empty: the default (the catalog service's slug, or the slug of the source's host). */
  readonly name: string;
  /** A private toolkit of the caller; a plain member's is always private. */
  readonly private: boolean;
  /** An org toolkit's. */
  readonly accepts: CredentialsAccepted;
  /** A catalog source's way to sign in it is added with (a key then goes where the source says). */
  readonly credential: ToolkitCredentialKind | undefined;
}

const detailsOf = (details: AddDetails): AddToolkit => {
  const name = details.name.trim();

  return {
    ...(name === "" ? {} : { name }),
    ...(details.private ? { private: true } : { accepts: details.accepts }),
  };
};

const catalogBody = (
  service: CatalogService,
  source: CatalogSource,
  details: AddDetails,
): AddToolkit => ({
  catalog: {
    service: service.id,
    source: source.id,
    ...(details.credential === undefined ? {} : { credential: details.credential }),
  },
  ...detailsOf(details),
});

/** The body of `POST /toolkits` that adds a toolkit from `origin`. */
export const addBody = (origin: AddOrigin, details: AddDetails): AddToolkit => {
  switch (origin.from) {
    case "catalog":
      return catalogBody(origin.service, origin.source, details);
    case "lookup":
      // A domain the catalog has is added from it; one detect or discover found, by its source's URL and kind, under
      // the domain's slug (the answer fills one toolkit and is never kept, #207).
      return origin.lookup.via === "catalog"
        ? catalogBody(origin.lookup.service, origin.source, details)
        : {
            kind: origin.source.kind,
            source: origin.source.url,
            name: origin.lookup.service.id,
            ...detailsOf(details),
          };
    case "url":
      return { kind: origin.kind, source: origin.url.trim(), ...detailsOf(details) };
    case "upload":
      return { kind: origin.kind, document: origin.document, ...detailsOf(details) };
  }
};

/** The domain to look up in what was typed: a URL's host, or a bare domain; `undefined` when it names none. */
export const domainOf = (typed: string): string | undefined => {
  const text = typed.trim().toLowerCase();

  if (text === "") return undefined;

  try {
    const { hostname } = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`);

    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname) ? hostname : undefined;
  } catch {
    return undefined;
  }
};

/** Whether what was typed is a whole URL, which can be added as it is. */
export const isWholeUrl = (typed: string): boolean => /^https?:\/\/\S+$/i.test(typed.trim());

const MIB = 1024 * 1024;

/** What Commissary reads of an uploaded document: 8 MiB, a GraphQL schema's SDL 4 MiB (`413 body_too_large` above). */
export const documentProblem = (kind: AddedToolkitKind, bytes: number): string | undefined => {
  if (kind === "graphql")
    return bytes > 4 * MIB ? "The schema is over 4 MiB, more than Commissary reads." : undefined;

  return bytes > 8 * MIB ? "The document is over 8 MiB, more than Commissary reads." : undefined;
};
