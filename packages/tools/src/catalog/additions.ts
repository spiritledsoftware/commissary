/**
 * The toolkit catalog additions (ADR 0036, #207): what Commissary records itself for the toolkit catalog on top of
 * integrations.sh's registry. Shipped with the Workers as versioned data (`catalog/additions.json`), never fetched.
 *
 * - `featured`: catalog slugs listed first, in this order.
 * - `services`: services the registry lacks (with `name` and `domain`), or sources a registry service lacks, by its
 *   slug: Google Discovery documents, which integrations.sh does not list. A source whose id the registry already has
 *   is left alone: the registry wins where it has a value, as models.dev does for model catalog additions.
 * - `corrections`: unlike a model catalog addition, a correction wins over the registry: a wrong spec URL, kind or auth
 *   method, or credential settings it lacks. Each names why (`reason`) and where it was offered upstream (`upstream`,
 *   an issue or pull request of integrations.sh), since integrations.sh's facts are partly read from docs by an agent.
 * - `managed_apps`: Commissary Cloud's own OAuth apps, by catalog slug (`managed-apps.ts`): the client id and
 *   endpoints only; the secret is the Workers' binding the entry names (`TOOLKIT_OAUTH_<NAME>`), never in this file.
 * - `tool_overrides`: overrides a toolkit added from a source gets for its tools (`<service>/<source>`, then the tool's
 *   upstream name): hidden by default, renamed, described anew, or classed `read` or `write`.
 *
 * Credential types use integrations.sh's names (`api_key`, `bearer`, `basic`, `oauth2`, `oauth2_cc`, `oauth1`, `tba`,
 * `jwt`, `app`, `two_step`, `aws_sigv4`, `compound`, and `none`), which map onto toolkit credentials directly
 * (`credentials.ts`). This module reads only `effect`, the contract's schemas and the JSON, so the ControlPlane part
 * bundles it without the registry snapshot.
 */
import { Result, Schema } from "effect";
import { CredentialSettings, ToolClass } from "@commissary/contract/tools";
import additionsJson from "./additions.json";
import { CatalogAuth } from "./credentials.ts";

const optional = Schema.optionalKey;

/** Who wrote what a toolkit gets from the catalog (its tools' overrides, a managed app), where an author is recorded. */
export const CATALOG_AUTHOR = "catalog";

/** The kinds a catalog source can be: integrations.sh's three, and Google Discovery documents from the additions. */
export const CatalogSourceKind = Schema.Literals(["mcp", "openapi", "graphql", "discovery"]);

export type CatalogSourceKind = typeof CatalogSourceKind.Type;

const AdditionSource = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: CatalogSourceKind,
  name: Schema.String,
  url: Schema.String,
  auth: optional(Schema.Array(CatalogAuth)),
  scopes: optional(Schema.Array(Schema.String)),
  credential_settings: optional(CredentialSettings),
});

export type AdditionSource = typeof AdditionSource.Type;

const AdditionService = Schema.Struct({
  id: Schema.NonEmptyString,
  /** Required for a service the registry lacks. */
  name: optional(Schema.String),
  domain: optional(Schema.String),
  description: optional(Schema.String),
  icon: optional(Schema.String),
  categories: optional(Schema.Array(Schema.String)),
  sources: Schema.Array(AdditionSource),
});

export type AdditionService = typeof AdditionService.Type;

const Correction = Schema.Struct({
  service: Schema.NonEmptyString,
  source: Schema.NonEmptyString,
  kind: optional(CatalogSourceKind),
  url: optional(Schema.String),
  auth: optional(Schema.Array(CatalogAuth)),
  scopes: optional(Schema.Array(Schema.String)),
  credential_settings: optional(CredentialSettings),
  /** What the registry has wrong. */
  reason: Schema.NonEmptyString,
  /** Where the correction was offered to integrations.sh. */
  upstream: Schema.NonEmptyString,
});

export type Correction = typeof Correction.Type;

/** A binding name a managed app's secret is read from. */
const SecretBinding = Schema.String.check(Schema.isPattern(/^TOOLKIT_OAUTH_[A-Z0-9_]+$/));

const ManagedApp = Schema.Struct({
  client_id: Schema.NonEmptyString,
  authorize_url: Schema.String,
  token_url: Schema.String,
  scopes: optional(Schema.Array(Schema.String)),
  issuer: optional(Schema.String),
  /** The Workers' binding that holds the client secret; unset on a deployment, the app is unavailable there. */
  secret: SecretBinding,
});

export type ManagedApp = typeof ManagedApp.Type;

const ToolOverride = Schema.Struct({
  hidden: optional(Schema.Boolean),
  name: optional(Schema.String),
  description: optional(Schema.String),
  class: optional(ToolClass),
});

export type CatalogToolOverride = typeof ToolOverride.Type;

export const Additions = Schema.Struct({
  featured: Schema.Array(Schema.String),
  services: Schema.Array(AdditionService),
  corrections: Schema.Array(Correction),
  managed_apps: Schema.Record(Schema.String, ManagedApp),
  /** By `<service>/<source>`, then the tool's upstream name. */
  tool_overrides: Schema.Record(Schema.String, Schema.Record(Schema.String, ToolOverride)),
});

export type Additions = typeof Additions.Type;

/** `json` as additions; throws on a malformed file (the bundled one is checked by the tests). */
export const additionsOf = (json: Schema.Json): Additions => {
  const decoded = Schema.decodeUnknownResult(Additions)(json);

  if (Result.isFailure(decoded))
    throw new Error(`toolkit catalog additions: ${decoded.failure.message}`);

  return decoded.success;
};

let bundled: Additions | undefined;

/** The bundled additions (`catalog/additions.json`), decoded once per isolate. */
export const bundledAdditions = (): Additions => (bundled ??= additionsOf(additionsJson));

/** The overrides a toolkit added from `service`'s `source` gets. */
export const toolOverridesOf = (
  additions: Additions,
  service: string,
  source: string,
): Readonly<Record<string, CatalogToolOverride>> =>
  additions.tool_overrides[`${service}/${source}`] ?? {};
