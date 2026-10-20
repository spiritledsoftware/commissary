/**
 * A toolkit's credential settings (#206): what each credential type takes from the toolkit rather than from the
 * credential (which is the same for its shared credential and its members' private ones, and which the toolkit catalog
 * fills later, #207): OAuth 1.0a's signature method and realm, NetSuite's account, a JWT's algorithm, claims and token
 * endpoint, a GitHub App's API, an RFC 8693 exchange's endpoint and parameters, AWS's region and service, and a compound
 * credential's template. The settings are checked when they are saved ({@link settingsRefusal}; the routes check their
 * URLs against the outbound guard), a credential against them when it is connected ({@link credentialRefusal}, {@link keyRefusal}), and a
 * connected secret becomes what signs a request with them ({@link upstreamOf}).
 */
import { Effect, Result } from "effect";
import type { CredentialSettings, ToolkitSecret } from "@commissary/contract/tools";
import { percentEncode, sha256Hex } from "../signing/encoding.ts";
import { importSigningKey } from "../signing/jwt.ts";
import type { OAuth1Keys } from "../signing/oauth1.ts";
import { renderTemplate, templateFields } from "../signing/template.ts";
import {
  type ConnectedSecret,
  headerNameRefusal,
  longerThan,
  type MintedKind,
  type UpstreamSecret,
} from "./secret.ts";
import type { StoredToolkit } from "./toolkit.ts";

/** Why settings cannot be saved, and the field (`credential_settings.<type>.<field>`). */
export interface SettingsRefusal {
  readonly message: string;
  readonly path: string;
}

/** The longest value a setting holds. */
const MAX_SETTING_LENGTH = 2048;

/** The claims a JWT's settings cannot set: Commissary sets them. */
const RESERVED_CLAIMS: ReadonlySet<string> = new Set(["iss", "sub", "aud", "iat", "exp"]);

/** A JWT's longest life, and its default (Google's and DocuSign's most). */
export const MAX_JWT_LIFETIME_SECONDS = 3600;

/** Why a JWT exchanged at a token endpoint is refused without its issuer. */
export const JWT_ISSUER = "a JWT exchanged at a token endpoint names its issuer (RFC 7523 §3)";

/** A JWT's shortest life: more than the minute before expiry a token is minted again, so one serves a while. */
const MIN_JWT_LIFETIME_SECONDS = 120;

const refusal = (path: string, message: string): SettingsRefusal => ({
  message,
  path: `credential_settings.${path}`,
});

const tooLong = (...values: ReadonlyArray<string | undefined>): boolean =>
  longerThan(MAX_SETTING_LENGTH, ...values);

/** Why `settings` cannot be saved on a toolkit of `kind`, if they cannot (their URLs are the routes' to check). */
export const settingsRefusal = (
  settings: CredentialSettings,
  kind: StoredToolkit["kind"],
): SettingsRefusal | undefined => {
  const { oauth1, tba, jwt, aws_sigv4: aws, compound } = settings;

  if (tooLong(oauth1?.realm)) return refusal("oauth1.realm", "the realm is too long");

  if (tba !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(tba.account_id))
    return refusal("tba.account_id", "a NetSuite account id is letters, digits, `_` and `-`");

  if (jwt !== undefined) {
    const lifetime = jwt.lifetime_seconds;

    if (
      lifetime !== undefined &&
      (lifetime < MIN_JWT_LIFETIME_SECONDS || lifetime > MAX_JWT_LIFETIME_SECONDS)
    )
      return refusal(
        "jwt.lifetime_seconds",
        `a JWT lives from ${MIN_JWT_LIFETIME_SECONDS} to ${MAX_JWT_LIFETIME_SECONDS} seconds`,
      );

    const reserved = Object.keys(jwt.claims ?? {}).find((claim) => RESERVED_CLAIMS.has(claim));

    if (reserved !== undefined)
      return refusal("jwt.claims", `the ${reserved} claim is Commissary's to set`);

    if (tooLong(jwt.audience, jwt.scope) || JSON.stringify(jwt.claims ?? {}).length > 8192)
      return refusal("jwt", "the JWT's claims are too long");
  }

  if (aws !== undefined) {
    if (!/^[a-z0-9-]{1,32}$/.test(aws.region))
      return refusal("aws_sigv4.region", "an AWS region is lowercase letters, digits and `-`");

    if (!/^[a-z0-9-]{1,64}$/.test(aws.service))
      return refusal("aws_sigv4.service", "an AWS service is lowercase letters, digits and `-`");
  }

  if (compound !== undefined) {
    for (const [name, template] of Object.entries(compound.headers ?? {})) {
      const refused = headerNameRefusal(name);

      if (refused !== undefined) return refusal(`compound.headers.${name}`, refused);

      if (tooLong(template)) return refusal(`compound.headers.${name}`, "the template is too long");
    }

    for (const [name, template] of Object.entries(compound.query ?? {}))
      if (name.trim() === "" || tooLong(name, template))
        return refusal(
          "compound.query",
          "a query parameter is named, and its template not too long",
        );

    if (compound.base_url !== undefined && kind !== "openapi")
      return refusal("compound.base_url", "only an OpenAPI toolkit's calls take a base URL");

    if (
      Object.keys(compound.headers ?? {}).length === 0 &&
      Object.keys(compound.query ?? {}).length === 0 &&
      compound.base_url === undefined
    )
      return refusal("compound", "a compound credential's template places its fields somewhere");
  }

  return undefined;
};

/** Every field a compound template names. */
const compoundFields = (compound: NonNullable<CredentialSettings["compound"]>) => [
  ...new Set(
    [
      ...Object.values(compound.headers ?? {}),
      ...Object.values(compound.query ?? {}),
      compound.base_url ?? "",
    ].flatMap(templateFields),
  ),
];

/**
 * Why `secret` cannot be connected to a toolkit with `settings`, if it cannot: its type needs settings it lacks, a
 * compound credential lacks a field the template names, or a JWT exchanged at a token endpoint names no issuer.
 */
export const credentialRefusal = (
  secret: ToolkitSecret,
  settings: CredentialSettings | undefined,
): string | undefined => {
  switch (secret.kind) {
    case "tba":
      return settings?.tba === undefined
        ? "set the toolkit's NetSuite account (credential_settings.tba) first"
        : undefined;
    case "jwt":
      if (settings?.jwt === undefined)
        return "set the toolkit's JWT settings (credential_settings.jwt) first";

      return settings.jwt.token_url !== undefined && secret.issuer === undefined
        ? JWT_ISSUER
        : undefined;
    case "token_exchange":
      return settings?.token_exchange === undefined
        ? "set the toolkit's token exchange (credential_settings.token_exchange) first"
        : undefined;
    case "aws_sigv4":
      return settings?.aws_sigv4 === undefined
        ? "set the toolkit's AWS region and service (credential_settings.aws_sigv4) first"
        : undefined;
    case "compound": {
      if (settings?.compound === undefined)
        return "set the toolkit's template (credential_settings.compound) first";

      const missing = compoundFields(settings.compound).find(
        (name) => !Object.hasOwn(secret.fields, name),
      );

      return missing === undefined
        ? undefined
        : `the toolkit's template names the field ${missing}, which the credential lacks`;
    }

    default:
      return undefined;
  }
};

/**
 * Why `secret`'s private key cannot sign as the toolkit's `settings` say, if it cannot: a JWT credential's key for the
 * JWT's algorithm, a GitHub App's for RS256. Checked when it is connected, so a wrong key is told at once.
 */
export const keyRefusal = (
  secret: ToolkitSecret,
  settings: CredentialSettings | undefined,
): Effect.Effect<string | undefined> => {
  const check =
    secret.kind === "jwt" && settings?.jwt !== undefined
      ? importSigningKey(settings.jwt.algorithm, secret.private_key)
      : secret.kind === "app"
        ? importSigningKey("RS256", secret.private_key)
        : undefined;

  if (check === undefined) return Effect.succeed(undefined);

  return Effect.map(Effect.result(check), (imported) =>
    Result.isFailure(imported) ? imported.failure.message : undefined,
  );
};

/** How OAuth 1.0a signs for a toolkit with `settings`: its signature method (default HMAC-SHA1) and realm. */
export const oauth1Signing = (
  settings: CredentialSettings | undefined,
): Pick<OAuth1Keys, "signatureMethod" | "realm"> => ({
  signatureMethod: settings?.oauth1?.signature_method ?? "HMAC-SHA1",
  realm: settings?.oauth1?.realm,
});

/**
 * What a minted credential of `kind` mints its token with from the toolkit's `settings`, as a fingerprint kept with
 * the token (`minted_with`): a token minted with other settings is not used, so changing them mints a new one. A
 * failure when the settings it needs are gone.
 */
export const mintedWith = (
  kind: MintedKind,
  settings: CredentialSettings | undefined,
): string | SettingsFailure => {
  const fingerprint = (
    entry: NonNullable<CredentialSettings[MintedKind & keyof CredentialSettings]>,
  ) => sha256Hex(JSON.stringify(entry));

  switch (kind) {
    case "client_credentials":
      return "";
    case "jwt":
      return settings?.jwt === undefined
        ? { failed: "the toolkit has no JWT settings" }
        : fingerprint(settings.jwt);
    case "app":
      return fingerprint(settings?.app ?? {});
    case "token_exchange":
      return settings?.token_exchange === undefined
        ? { failed: "the toolkit has no token exchange settings" }
        : fingerprint(settings.token_exchange);
  }
};

/** A failure to sign in with a connected secret: the toolkit's settings changed since it was connected. */
export interface SettingsFailure {
  readonly failed: string;
}

/**
 * What signs a request in with the connected `secret` and the toolkit's `settings`: a static secret as it is, an OAuth
 * 1.0a or SigV4 signer, a compound credential's fields placed by the template; a failure when the settings it needs are
 * gone or name a field it lacks.
 */
export const upstreamOf = (
  secret: ConnectedSecret,
  settings: CredentialSettings | undefined,
): UpstreamSecret | SettingsFailure => {
  switch (secret.kind) {
    case "oauth1":
      return {
        kind: "oauth1",
        keys: {
          consumerKey: secret.consumer_key,
          consumerSecret: secret.consumer_secret,
          token: secret.token,
          tokenSecret: secret.token_secret,
          ...oauth1Signing(settings),
        },
      };
    case "tba": {
      const account = settings?.tba?.account_id;

      if (account === undefined) return { failed: "the toolkit has no NetSuite account set" };

      return {
        kind: "oauth1",
        keys: {
          consumerKey: secret.consumer_key,
          consumerSecret: secret.consumer_secret,
          token: secret.token_id,
          tokenSecret: secret.token_secret,
          signatureMethod: "HMAC-SHA256",
          realm: account,
        },
      };
    }

    case "aws_sigv4": {
      const aws = settings?.aws_sigv4;

      if (aws === undefined) return { failed: "the toolkit has no AWS region and service set" };

      return {
        kind: "aws_sigv4",
        keys: {
          accessKeyId: secret.access_key_id,
          secretAccessKey: secret.secret_access_key,
          region: aws.region,
          service: aws.service,
        },
        ...(secret.session_token === undefined ? {} : { sessionToken: secret.session_token }),
      };
    }

    case "compound":
      return compoundOf(secret.fields, settings?.compound);
    default:
      return secret;
  }
};

/** A compound credential's fields placed by `compound`. */
const compoundOf = (
  fields: Readonly<Record<string, string>>,
  compound: CredentialSettings["compound"],
): UpstreamSecret | SettingsFailure => {
  if (compound === undefined)
    return { failed: "the toolkit has no template for its compound credential" };

  const place = (
    templates: Readonly<Record<string, string>> | undefined,
  ): ReadonlyArray<readonly [string, string]> | string => {
    const placed: Array<readonly [string, string]> = [];

    for (const [name, template] of Object.entries(templates ?? {})) {
      const rendered = renderTemplate(template, fields);

      if (!rendered.ok) return rendered.missing;
      placed.push([name, rendered.value]);
    }

    return placed;
  };

  const headers = place(compound.headers);
  const query = place(compound.query);

  const baseUrl =
    compound.base_url === undefined
      ? undefined
      : renderTemplate(compound.base_url, fields, percentEncode);

  const lacking = (missing: string): SettingsFailure => ({
    failed: `the credential lacks the field ${missing} the toolkit's template names`,
  });

  if (typeof headers === "string") return lacking(headers);

  if (typeof query === "string") return lacking(query);

  if (baseUrl !== undefined && !baseUrl.ok) return lacking(baseUrl.missing);

  return {
    kind: "compound",
    headers,
    query,
    ...(baseUrl?.ok === true ? { baseUrl: baseUrl.value } : {}),
  };
};
