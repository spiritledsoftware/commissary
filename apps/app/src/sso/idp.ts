/**
 * Setting up and testing an org's identity provider (issue #76). New in the Workers port.
 *
 * An OIDC provider is given by its issuer and Commissary's client there: Commissary reads the issuer's discovery
 * document once, when the provider is saved, and keeps the endpoints it names (Better Auth's SSO plugin does the
 * discovery, `discoverOIDCConfig`, with its checks: the document's issuer must be the one given, and every endpoint
 * must pass the outbound guard, ADR 0044). A SAML provider is given by its sign-in URL, its entity id and its signing certificate.
 *
 * Testing a provider asks it again without signing anyone in: the discovery document and the signing keys of an OIDC
 * provider; the certificate's validity of a SAML one.
 */
import { X509Certificate } from "node:crypto";
import { Effect, Result } from "effect";
import {
  checkOutboundUrl,
  CurrentOutboundPolicy,
  OUTBOUND_REFUSED_MESSAGE,
  type OutboundPolicy,
} from "@commissary/core";
import type { IdpSettings, OidcSettings, SamlSettings } from "@commissary/auth/sso";

/** Why a provider was refused or failed its test; `message` is safe to show the org owner. */
export interface IdpProblem {
  readonly error: "invalid_provider" | "discovery_failed" | "provider_unreachable";
  readonly message: string;
}

const MAX_TEXT = 2048;

const MAX_CERTIFICATE = 16_384;

/** How long a provider's endpoints may take to answer. */
const FETCH_TIMEOUT_MS = 10_000;

const problem = (error: IdpProblem["error"], message: string): IdpProblem => ({ error, message });

/**
 * `value` as a URL Commissary may fetch: one the outbound guard (ADR 0044) lets through under `policy`, without
 * credentials. `undefined` otherwise.
 */
const outboundUrl = (value: string, policy: OutboundPolicy): URL | undefined => {
  const checked = checkOutboundUrl(value, policy);

  if (Result.isFailure(checked)) return undefined;

  return checked.success.username === "" && checked.success.password === ""
    ? checked.success
    : undefined;
};

/** Why a provider's URL is refused, naming which one: the outbound guard's message. */
const refusedUrl = (what: string): IdpProblem =>
  problem("invalid_provider", `${what}: ${OUTBOUND_REFUSED_MESSAGE}`);

/** What an org owner sends for an OIDC provider; an empty secret keeps the stored one (`SsoStore.setProvider`). */
export interface OidcInput {
  readonly kind: "oidc";
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface SamlInput {
  readonly kind: "saml";
  readonly entryPoint: string;
  readonly idpEntityId: string;
  readonly certificate: string;
}

export type IdpInput = OidcInput | SamlInput;

/** Better Auth's discovery, which trusts an endpoint only when the outbound guard lets it through. */
const discover = (
  issuer: string,
  policy: OutboundPolicy,
): Effect.Effect<Omit<OidcSettings, "clientId" | "clientSecret">, IdpProblem> =>
  Effect.tryPromise({
    try: async () => {
      const { discoverOIDCConfig } = await import("@better-auth/sso");

      return await discoverOIDCConfig({
        issuer,
        isTrustedOrigin: (url) => outboundUrl(url, policy) !== undefined,
        timeout: FETCH_TIMEOUT_MS,
      });
    },
    catch: (cause) =>
      problem(
        "discovery_failed",
        `the issuer's discovery document could not be used: ${cause instanceof Error ? cause.message : "unknown error"}`,
      ),
  }).pipe(
    Effect.map((found) => ({
      kind: "oidc" as const,
      issuer: found.issuer,
      authorizationEndpoint: found.authorizationEndpoint,
      tokenEndpoint: found.tokenEndpoint,
      jwksEndpoint: found.jwksEndpoint,
      ...(found.userInfoEndpoint === undefined ? {} : { userInfoEndpoint: found.userInfoEndpoint }),
      ...(found.tokenEndpointAuthentication === "client_secret_post"
        ? { tokenEndpointAuthentication: "client_secret_post" as const }
        : {}),
    })),
  );

const text = (value: string): string | undefined => {
  const trimmed = value.trim();

  return trimmed === "" || trimmed.length > MAX_TEXT ? undefined : trimmed;
};

/** The certificate as PEM; `undefined` when it does not parse. */
const pemOf = (certificate: string): string | undefined => {
  const trimmed = certificate.trim();

  if (trimmed === "" || trimmed.length > MAX_CERTIFICATE) return undefined;

  const pem = trimmed.includes("-----BEGIN")
    ? trimmed
    : `-----BEGIN CERTIFICATE-----\n${trimmed.replace(/\s+/g, "")}\n-----END CERTIFICATE-----`;

  try {
    new X509Certificate(pem);

    return pem;
  } catch {
    return undefined;
  }
};

/** When the certificate stops being valid; a problem when it is not valid at `now`. */
const certificateWindow = (pem: string, now: number): IdpProblem | { readonly validTo: string } => {
  const certificate = new X509Certificate(pem);

  if (now < Date.parse(certificate.validFrom))
    return problem("invalid_provider", "the certificate is not valid yet");

  if (now > Date.parse(certificate.validTo))
    return problem("invalid_provider", "the certificate has expired");

  return { validTo: new Date(certificate.validTo).toISOString() };
};

/** The settings to store for `input` (an OIDC issuer is discovered here), or why it is refused. */
export const resolveIdp = (input: IdpInput, now: number): Effect.Effect<IdpSettings, IdpProblem> =>
  Effect.gen(function* () {
    const policy = yield* CurrentOutboundPolicy;

    if (input.kind === "oidc") {
      const issuer = text(input.issuer);
      const clientId = text(input.clientId);

      if (issuer === undefined)
        return yield* Effect.fail(problem("invalid_provider", "the issuer is missing"));

      if (outboundUrl(issuer, policy) === undefined)
        return yield* Effect.fail(refusedUrl("the issuer"));

      if (clientId === undefined)
        return yield* Effect.fail(problem("invalid_provider", "the client id is missing"));

      if (input.clientSecret.length > MAX_TEXT)
        return yield* Effect.fail(problem("invalid_provider", "the client secret is too long"));
      const found = yield* discover(issuer, policy);

      return { ...found, clientId, clientSecret: input.clientSecret.trim() } satisfies OidcSettings;
    }

    const entryPoint = text(input.entryPoint);
    const idpEntityId = text(input.idpEntityId);

    if (entryPoint === undefined)
      return yield* Effect.fail(problem("invalid_provider", "the sign-in URL is missing"));

    if (outboundUrl(entryPoint, policy) === undefined)
      return yield* Effect.fail(refusedUrl("the sign-in URL"));

    if (idpEntityId === undefined)
      return yield* Effect.fail(problem("invalid_provider", "the entity id is missing"));
    const certificate = pemOf(input.certificate);

    if (certificate === undefined)
      return yield* Effect.fail(
        problem("invalid_provider", "the certificate is not a PEM or base64 X.509 certificate"),
      );
    const window = certificateWindow(certificate, now);

    if ("error" in window) return yield* Effect.fail(window);

    return { kind: "saml", entryPoint, idpEntityId, certificate } satisfies SamlSettings;
  });

/** What a test found: a short summary for the org owner. */
export interface IdpTestResult {
  readonly message: string;
}

/**
 * Asks the provider again: an OIDC issuer's discovery document must still name the stored endpoints' issuer and its
 * signing keys must load; a SAML certificate must be valid at `now`.
 */
export const testIdp = (
  settings: IdpSettings,
  now: number,
): Effect.Effect<IdpTestResult, IdpProblem> =>
  Effect.gen(function* () {
    if (settings.kind === "saml") {
      const window = certificateWindow(settings.certificate, now);

      if ("error" in window) return yield* Effect.fail(window);

      return { message: `the certificate is valid until ${window.validTo}` };
    }

    // The stored endpoints pass the outbound guard again: they were stored before it existed, or a policy changed.
    const policy = yield* CurrentOutboundPolicy;

    if (outboundUrl(settings.issuer, policy) === undefined)
      return yield* Effect.fail(refusedUrl("the issuer"));

    if (outboundUrl(settings.jwksEndpoint, policy) === undefined)
      return yield* Effect.fail(refusedUrl("the signing keys' URL"));

    yield* discover(settings.issuer, policy);

    const keys = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(settings.jwksEndpoint, {
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json<{ readonly keys?: unknown }>();

        return Array.isArray(body.keys) ? body.keys.length : 0;
      },
      catch: (cause) =>
        problem(
          "provider_unreachable",
          `the signing keys could not be loaded: ${cause instanceof Error ? cause.message : "unknown error"}`,
        ),
    });

    if (keys === 0)
      return yield* Effect.fail(
        problem("provider_unreachable", "the identity provider publishes no signing keys"),
      );

    return { message: `the discovery document and ${keys} signing key(s) loaded` };
  });
