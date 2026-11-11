/**
 * `/v9/management/sso*` (`SsoGroup` in @commissary/contract/sso): an org's single sign-on on Commissary Cloud (issue
 * #76): its identity provider and the email domains it proves with a DNS TXT record. A self-hosted Commissary has no
 * such routes. Workers addition, no Go counterpart.
 *
 * Org admins read the settings (`policy.ts`); changing them takes the org owner role. A domain becomes the org's
 * when its TXT record is found and the Platform registry gives it to the org, which it refuses while another org holds
 * it (`PlatformStore.claimSsoDomain`); removing a domain or the org frees it there. Requiring single sign-on for a
 * domain is recorded in both, so the sign-in can refuse GitHub and Google for it (the auth Worker, apps/auth), and ends the
 * sessions of everyone at the domain: they sign in again, through the identity provider.
 */
import { X509Certificate } from "node:crypto";
import { Clock, Effect, Schema } from "effect";
import { HttpRouter, type HttpServerResponse } from "effect/http";
import { AccessPrincipal, type Principal, roleAtLeast } from "@commissary/auth";
import { challengeRecord, serviceProviderOf } from "@commissary/auth/sso";
import { hostedOnly } from "../hosted/only.ts";
import { configuredAuthOrigin, endDomainSessions } from "../hosted/sign-in.ts";
import { lookupTxt } from "../sso/dns.ts";
import { type IdpInput, type IdpProblem, resolveIdp, testIdp } from "../sso/idp.ts";
import {
  controlPlane,
  type SsoDomain,
  type SsoErrorCode,
  type SsoResult,
  type StoredIdp,
  bodyJson,
} from "@commissary/state";
import {
  AddSsoDomain,
  SsoProviderInput,
  type SsoDomainView,
  type SsoProviderView,
  type SsoSettings,
  UpdateSsoDomain,
} from "@commissary/contract/sso";
import { handled, jsonReply, type Reply, replyError } from "@commissary/core";
import { registry } from "./org-routes.ts";

const BASE = "/v9/management";

const STATUS: Readonly<Record<SsoErrorCode, number>> = {
  invalid_domain: 422,
  domain_exists: 409,
  too_many_domains: 409,
  domain_not_found: 404,
  domain_unverified: 409,
  provider_missing: 404,
  client_secret_required: 422,
  sso_required: 409,
};

const iso = (ms: number): string => new Date(ms).toISOString();

const providerView = (stored: StoredIdp): SsoProviderView => {
  const { settings } = stored;
  const updated = { updated_at: iso(stored.updatedAt), updated_by: stored.updatedBy };

  if (settings.kind === "oidc")
    return {
      kind: "oidc",
      issuer: settings.issuer,
      client_id: settings.clientId,
      authorization_endpoint: settings.authorizationEndpoint,
      token_endpoint: settings.tokenEndpoint,
      ...updated,
    };

  return {
    kind: "saml",
    entry_point: settings.entryPoint,
    idp_entity_id: settings.idpEntityId,
    certificate_expires_at: new Date(
      new X509Certificate(settings.certificate).validTo,
    ).toISOString(),
    ...updated,
  };
};

const domainView = (domain: SsoDomain): SsoDomainView => ({
  domain: domain.domain,
  verified: domain.verifiedAt !== undefined,
  ...(domain.verifiedAt === undefined ? {} : { verified_at: iso(domain.verifiedAt) }),
  require_sso: domain.requireSso,
  record: challengeRecord(domain.domain, domain.token),
});

/** Who changed a setting, as the settings show it. */
const actorOf = (principal: Principal): string => {
  switch (principal.kind) {
    case "user":
    case "key":
      return principal.email.toLowerCase();
    case "service":
      return `service:${principal.commonName}`;
    case "mkey":
      return `key:${principal.keyId}`;
  }
};

/**
 * The org owner role, needed for every change, held by a person (or a platform admin): an identity provider signs
 * people in, so a management key, which never carries a person's powers (ADR 0026), cannot set one.
 */
const ownerOnly = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  if (identity.principal.kind === "mkey")
    return yield* replyError(403, "management_key_forbidden", {
      message: "a management key cannot change single sign-on",
    });

  if (!roleAtLeast(identity.role, "owner"))
    return yield* replyError(403, "owner_required", {
      message: "only an org owner can change single sign-on",
    });

  return identity;
});

const refusal = <A>(result: SsoResult<A>): Effect.Effect<A, Reply> =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(replyError(STATUS[result.error], result.error, { message: result.message }));

const idpRefusal = (problem: IdpProblem): Reply =>
  replyError(422, problem.error, { message: problem.message });

const decoded = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  bodyJson.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() => replyError(400, "invalid body")),
      ),
    ),
  );

/** The auth host's origin, where Better Auth's SSO plugin answers the identity providers (ADR 0030). */
const authOrigin = Effect.gen(function* () {
  const origin = yield* configuredAuthOrigin;

  return origin ?? (yield* replyError(500, "Sign-in is not configured"));
});

const domainParam = Effect.map(HttpRouter.params, (params) => params["domain"] ?? "");

const getSettings = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const origin = yield* authOrigin;
  const state = yield* controlPlane("ssoState", (stub) => stub.ssoState());
  const sp = serviceProviderOf(origin, identity.org);

  const body: SsoSettings = {
    provider: state.provider === undefined ? null : providerView(state.provider),
    domains: state.domains.map(domainView),
    service_provider: {
      oidc_redirect_uri: sp.oidcRedirectUri,
      saml_acs_url: sp.samlAcsUrl,
      saml_entity_id: sp.samlEntityId,
      saml_metadata_url: sp.samlMetadataUrl,
    },
  };

  return jsonReply(200, body);
});

const setProvider = Effect.gen(function* () {
  const identity = yield* ownerOnly;
  const input = yield* decoded(SsoProviderInput);
  const now = yield* Clock.currentTimeMillis;

  const idp: IdpInput =
    input.kind === "oidc"
      ? {
          kind: "oidc",
          issuer: input.issuer,
          clientId: input.client_id,
          clientSecret: input.client_secret ?? "",
        }
      : {
          kind: "saml",
          entryPoint: input.entry_point,
          idpEntityId: input.idp_entity_id,
          certificate: input.certificate,
        };

  const settings = yield* resolveIdp(idp, now).pipe(Effect.mapError(idpRefusal));

  const stored = yield* refusal(
    yield* controlPlane("setSsoProvider", (stub) =>
      stub.setSsoProvider(settings, actorOf(identity.principal), now),
    ),
  );

  return jsonReply(200, providerView(stored));
});

const removeProvider = Effect.gen(function* () {
  yield* ownerOnly;

  const removed = yield* refusal(
    yield* controlPlane("removeSsoProvider", (stub) => stub.removeSsoProvider()),
  );

  return jsonReply(200, providerView(removed));
});

const testProvider = Effect.gen(function* () {
  yield* ownerOnly;
  const state = yield* controlPlane("ssoState", (stub) => stub.ssoState());

  if (state.provider === undefined)
    return yield* replyError(404, "provider_missing", { message: "no identity provider is set" });
  const now = yield* Clock.currentTimeMillis;
  const result = yield* testIdp(state.provider.settings, now).pipe(Effect.mapError(idpRefusal));

  return jsonReply(200, { message: result.message });
});

const addDomain = Effect.gen(function* () {
  yield* ownerOnly;
  const input = yield* decoded(AddSsoDomain);
  const now = yield* Clock.currentTimeMillis;

  const added = yield* refusal(
    yield* controlPlane("addSsoDomain", (stub) => stub.addSsoDomain(input.domain, now)),
  );

  return jsonReply(201, domainView(added));
});

const verifyDomain = Effect.gen(function* () {
  const identity = yield* ownerOnly;
  const param = yield* domainParam;
  const domain = yield* refusal(yield* controlPlane("ssoDomain", (stub) => stub.ssoDomain(param)));
  const record = challengeRecord(domain.domain, domain.token);
  const lookup = yield* lookupTxt(record.name);

  if (lookup.kind === "unavailable")
    return yield* replyError(503, "dns_unavailable", {
      message: "the DNS lookup failed; try again in a moment",
    });

  if (!lookup.records.some((value) => value.trim() === record.value))
    return yield* replyError(422, "record_not_found", {
      message: `no TXT record ${record.name} holds the value ${record.value} yet`,
    });

  const claim = yield* registry("claimSsoDomain", (stub) =>
    stub.claimSsoDomain(domain.domain, identity.org),
  );

  if (!claim.ok) return yield* replyError(409, claim.error, { message: claim.message });
  const now = yield* Clock.currentTimeMillis;

  const marked = yield* controlPlane("markSsoDomainVerified", (stub) =>
    stub.markSsoDomainVerified(domain.domain, now),
  );

  // Removed while it was being verified: the registry must not keep it for the org.
  if (!marked.ok)
    yield* registry("releaseSsoDomain", (stub) =>
      stub.releaseSsoDomain(domain.domain, identity.org),
    );

  return jsonReply(200, domainView(yield* refusal(marked)));
});

const updateDomain = Effect.gen(function* () {
  const identity = yield* ownerOnly;
  const param = yield* domainParam;
  const input = yield* decoded(UpdateSsoDomain);

  const updated = yield* refusal(
    yield* controlPlane("setSsoDomainRequired", (stub) =>
      stub.setSsoDomainRequired(param, input.require_sso),
    ),
  );

  if (updated.verifiedAt !== undefined) {
    const recorded = yield* registry("setSsoDomainRequired", (stub) =>
      stub.setSsoDomainRequired(updated.domain, identity.org, updated.requireSso),
    );

    // The registry no longer gives the domain to the org (freed by a removal that did not finish): undo the change.
    if (!recorded) {
      yield* controlPlane("setSsoDomainRequired", (stub) =>
        stub.setSsoDomainRequired(param, !input.require_sso),
      );

      return yield* replyError(409, "domain_unverified", {
        message: `the domain ${updated.domain} is not verified for this org any more; verify it again`,
      });
    }
  }

  // GitHub and Google sessions of the domain's people would outlive the requirement: end them all.
  if (updated.requireSso) {
    const ended = yield* endDomainSessions(updated.domain).pipe(
      Effect.catch((error) =>
        Effect.logError(`sessions not ended: ${error.message}`).pipe(
          Effect.annotateLogs({ org: identity.org }),
          Effect.andThen(
            Effect.fail(
              replyError(503, "sessions_not_ended", {
                message:
                  "single sign-on is required now, but the domain's sessions could not be ended; save again to retry",
              }),
            ),
          ),
        ),
      ),
    );

    yield* Effect.logInfo("single sign-on required").pipe(
      Effect.annotateLogs({ org: identity.org, sessionsEnded: ended }),
    );
  }

  return jsonReply(200, domainView(updated));
});

const removeDomain = Effect.gen(function* () {
  const identity = yield* ownerOnly;
  const param = yield* domainParam;

  const domain = yield* refusal(yield* controlPlane("ssoDomain", (stub) => stub.ssoDomain(param)));

  // Freed in the registry first: should the ControlPlane fail next, the domain is still listed there and removing it
  // again finishes the job, rather than the registry keeping a domain the org no longer lists.
  yield* registry("releaseSsoDomain", (stub) => stub.releaseSsoDomain(domain.domain, identity.org));

  const removed = yield* refusal(
    yield* controlPlane("removeSsoDomain", (stub) => stub.removeSsoDomain(domain.domain)),
  );

  return jsonReply(200, domainView(removed));
});

const route = <R>(
  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>,
) => HttpRouter.route(method, `${BASE}${path}`, hostedOnly(handled(handler)));

export const ssoRoutes = [
  route("GET", "/sso", getSettings),
  route("PUT", "/sso/provider", setProvider),
  route("DELETE", "/sso/provider", removeProvider),
  route("POST", "/sso/provider/test", testProvider),
  route("POST", "/sso/domains", addDomain),
  route("POST", "/sso/domains/:domain/verify", verifyDomain),
  route("PATCH", "/sso/domains/:domain", updateDomain),
  route("DELETE", "/sso/domains/:domain", removeDomain),
];
