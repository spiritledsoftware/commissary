// Per-org single sign-on on Commissary Cloud (issue #76; src/sso/, src/management/sso-routes.ts): an org owner proves an
// email domain with a DNS TXT record and sets one identity provider, which signs people in on the auth host (ADR 0030;
// the sign-in itself is the auth Worker's, apps/auth/test/sso.test.ts); requiring single sign-on for a domain ends the
// sessions of its people. The DNS resolver and the identity provider's discovery are fakes behind the global `fetch`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetStandingCaches } from "@commissary/auth";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import { DOH_URL } from "../../src/sso/dns.ts";
import {
  AUTH_ORIGIN,
  call,
  clearPeople,
  installFakes,
  panelHeaders,
  restoreFetch,
  signIn,
} from "./support.ts";

/** The fake OIDC issuer: its discovery document and one signing key. */
const OIDC_ISSUER = "https://login.acme-idp.com";

const OIDC_CLIENT_ID = "proxy-client";

const OIDC_CLIENT_SECRET = "proxy-client-secret";

/** The issuer's answer to `request`, `undefined` for any other host. */
const oidcIssuer = (request: Request): Response | undefined => {
  const url = new URL(request.url);

  if (url.origin !== OIDC_ISSUER) return undefined;

  if (url.pathname === "/.well-known/openid-configuration")
    return Response.json({
      issuer: OIDC_ISSUER,
      authorization_endpoint: `${OIDC_ISSUER}/authorize`,
      token_endpoint: `${OIDC_ISSUER}/token`,
      jwks_uri: `${OIDC_ISSUER}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });

  if (url.pathname === "/jwks")
    return Response.json({ keys: [{ kty: "RSA", kid: "key-1", alg: "RS256", use: "sig" }] });

  return new Response("not found", { status: 404 });
};

/** An issuer whose discovery document names its signing keys at the cloud metadata address. */
const METADATA_ISSUER = "https://login.metadata-idp.com";

const metadataIssuer = (request: Request): Response | undefined => {
  const url = new URL(request.url);

  if (url.origin !== METADATA_ISSUER) return undefined;

  return Response.json({
    issuer: METADATA_ISSUER,
    authorization_endpoint: `${METADATA_ISSUER}/authorize`,
    token_endpoint: `${METADATA_ISSUER}/token`,
    jwks_uri: "https://169.254.169.254/latest/meta-data/jwks",
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  });
};

/** TXT records the fake resolver answers, by name. */
const txt = new Map<string, Array<string>>();

/** DNS over HTTPS: TXT records from {@link txt}; any other question (an address lookup) has no answer. */
const resolver = (request: Request): Response | undefined => {
  const url = new URL(request.url);

  if (`${url.origin}${url.pathname}` !== DOH_URL) return undefined;
  const name = url.searchParams.get("name") ?? "";

  if (url.searchParams.get("type") !== "TXT") return Response.json({ Status: 0, Answer: [] });

  return Response.json({
    Status: 0,
    Answer: (txt.get(name) ?? []).map((value) => ({ name, type: 16, data: `"${value}"` })),
  });
};

beforeAll(async () => {
  await installFakes();

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    return (
      resolver(request) ??
      oidcIssuer(request) ??
      metadataIssuer(request) ??
      new Response(`unexpected ${request.url}`, { status: 599 })
    );
  };
});

afterAll(restoreFetch);

beforeEach(async () => {
  await clearPeople();
  resetStandingCaches();
});

/** A JSON management request of the signed-in `cookie`. */
const json = (
  cookie: string,
  method: string,
  body?: Readonly<Record<string, string | boolean>>,
) => ({
  method,
  headers: panelHeaders(cookie, { "content-type": "application/json" }),
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const sso = (org: string, path = "") => `/v9/management/orgs/${org}/sso${path}`;

interface DomainView {
  readonly domain: string;
  readonly verified: boolean;
  readonly require_sso: boolean;
  readonly record: { readonly name: string; readonly value: string };
}

interface Settings {
  readonly provider: Record<string, unknown> | null;
  readonly domains: ReadonlyArray<DomainView>;
  readonly service_provider: {
    readonly oidc_redirect_uri: string;
    readonly saml_acs_url: string;
    readonly saml_entity_id: string;
    readonly saml_metadata_url: string;
  };
}

/** An org `slug` owned by a fresh owner (signed in with GitHub, at another domain); the owner's cookie. */
const orgOwnedBy = async (slug: string): Promise<string> => {
  const owner = await signIn({ email: `owner-${slug}@example.com` });

  expect(
    (await call("/v9/management/orgs", json(owner, "POST", { slug, name: slug }))).status,
  ).toBe(201);

  return owner;
};

/** Adds `domain` to the org, publishes its TXT record and verifies it; the verify response. */
const proveDomain = async (owner: string, org: string, domain: string): Promise<Response> => {
  const added = await call(sso(org, "/domains"), json(owner, "POST", { domain }));
  expect(added.status).toBe(201);
  const { record } = await added.json<DomainView>();

  txt.set(record.name, [...(txt.get(record.name) ?? []), record.value]);

  return await call(sso(org, `/domains/${domain}/verify`), json(owner, "POST"));
};

const setOidc = (owner: string, org: string) =>
  call(
    sso(org, "/provider"),
    json(owner, "PUT", {
      kind: "oidc",
      issuer: OIDC_ISSUER,
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
    }),
  );

/** An org with `domain` verified and the fake OIDC issuer as its provider; the owner's cookie. */
const oidcOrg = async (slug: string, domain: string): Promise<string> => {
  const owner = await orgOwnedBy(slug);

  expect((await proveDomain(owner, slug, domain)).status).toBe(200);
  expect((await setOidc(owner, slug)).status).toBe(200);

  return owner;
};

const signedIn = async (cookie: string) =>
  await call("/v9/management/me", { headers: panelHeaders(cookie) });

describe("setting up single sign-on", () => {
  it("proves a domain with its TXT record and keeps the client secret out of the settings", async () => {
    const owner = await orgOwnedBy("setup");

    const added = await call(
      sso("setup", "/domains"),
      json(owner, "POST", { domain: "Setup.COM" }),
    );

    expect(added.status).toBe(201);
    const domain = await added.json<DomainView>();

    expect(domain).toMatchObject({ domain: "setup.com", verified: false, require_sso: false });
    expect(domain.record.name).toBe("_commissary-challenge.setup.com");

    // No record yet.
    const early = await call(sso("setup", "/domains/setup.com/verify"), json(owner, "POST"));
    expect(early.status).toBe(422);
    expect(await early.json()).toMatchObject({ error: "record_not_found" });

    txt.set(domain.record.name, ["something else", domain.record.value]);
    const verified = await call(sso("setup", "/domains/setup.com/verify"), json(owner, "POST"));
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ domain: "setup.com", verified: true });

    // Requiring single sign-on needs a provider first.
    const earlyRequire = await call(
      sso("setup", "/domains/setup.com"),
      json(owner, "PATCH", { require_sso: true }),
    );

    expect(earlyRequire.status).toBe(404);
    expect(await earlyRequire.json()).toMatchObject({ error: "provider_missing" });

    expect((await setOidc(owner, "setup")).status).toBe(200);
    const settings = await call(sso("setup"), { headers: panelHeaders(owner) });
    const body = await settings.text();

    expect(body).not.toContain(OIDC_CLIENT_SECRET);
    // SAFETY: a 200 answers `SsoSettings` (@commissary/contract/sso).
    const parsed = JSON.parse(body) as Settings;

    expect(parsed).toMatchObject({
      provider: {
        kind: "oidc",
        issuer: OIDC_ISSUER,
        client_id: OIDC_CLIENT_ID,
        token_endpoint: `${OIDC_ISSUER}/token`,
      },
      domains: [{ domain: "setup.com", verified: true }],
    });

    // The identity provider sends people back to the auth host, where Better Auth's SSO plugin answers.
    const sp = parsed.service_provider;
    expect(sp.oidc_redirect_uri.startsWith(`${AUTH_ORIGIN}/api/auth/sso/callback/sso-`)).toBe(true);
    expect(sp.saml_acs_url.startsWith(`${AUTH_ORIGIN}/api/auth/sso/saml2/sp/acs/sso-`)).toBe(true);

    // The provider answers a test.
    const test = await call(sso("setup", "/provider/test"), json(owner, "POST"));
    expect(test.status).toBe(200);
  });

  it("does not let a management key change it, even an owner's", async () => {
    const owner = await orgOwnedBy("keyed-sso");

    const issued = await call(
      "/v9/management/orgs/keyed-sso/management-keys",
      json(owner, "POST", { name: "ci", role: "owner" }),
    );

    expect(issued.status).toBe(201);
    const { key } = await issued.json<{ key: string }>();
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

    expect((await call(sso("keyed-sso"), { headers })).status).toBe(200);

    const refused = await call(sso("keyed-sso", "/domains"), {
      method: "POST",
      headers,
      body: JSON.stringify({ domain: "keyed.com" }),
    });

    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "management_key_forbidden" });
  });

  it("does not let a second org claim a domain another org verified", async () => {
    const first = await orgOwnedBy("first");
    expect((await proveDomain(first, "first", "shared.com")).status).toBe(200);

    const second = await orgOwnedBy("second");
    const claimed = await proveDomain(second, "second", "shared.com");

    expect(claimed.status).toBe(409);
    expect(await claimed.json()).toMatchObject({ error: "domain_taken" });

    // Once the first org removes it, the second can verify it.
    expect((await call(sso("first", "/domains/shared.com"), json(first, "DELETE"))).status).toBe(
      200,
    );
    expect(
      (await call(sso("second", "/domains/shared.com/verify"), json(second, "POST"))).status,
    ).toBe(200);
  });
});

describe("the outbound guard on an identity provider's URLs (ADR 0044)", () => {
  const setProvider = (owner: string, org: string, body: Readonly<Record<string, string>>) =>
    call(sso(org, "/provider"), json(owner, "PUT", body));

  it("refuses an issuer or a SAML sign-in URL at a private address", async () => {
    const owner = await orgOwnedBy("private-idp");

    const oidc = await setProvider(owner, "private-idp", {
      kind: "oidc",
      issuer: "https://10.0.0.8",
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
    });

    expect(oidc.status).toBe(422);
    expect(await oidc.json()).toMatchObject({
      error: "invalid_provider",
      message: `the issuer: ${OUTBOUND_REFUSED_MESSAGE}`,
    });

    const saml = await setProvider(owner, "private-idp", {
      kind: "saml",
      entry_point: "http://idp.example.com/sso",
      idp_entity_id: "urn:idp",
      certificate: "x",
    });

    expect(saml.status).toBe(422);
    expect(await saml.json()).toMatchObject({
      message: `the sign-in URL: ${OUTBOUND_REFUSED_MESSAGE}`,
    });
  });

  it("refuses a discovery document that names an endpoint the guard refuses", async () => {
    const owner = await orgOwnedBy("metadata-idp");

    const refused = await setProvider(owner, "metadata-idp", {
      kind: "oidc",
      issuer: METADATA_ISSUER,
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
    });

    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: "discovery_failed" });
  });
});

describe("requiring single sign-on", () => {
  it("ends the sessions the domain's people had, and keeps the provider while a domain requires it", async () => {
    const owner = await oidcOrg("strict-org", "strict.com");
    const atDomain = await signIn({ email: "gina@strict.com" });
    const other = await signIn({ email: "gina@example.com" });

    expect((await signedIn(atDomain)).status).toBe(200);

    const required = await call(
      sso("strict-org", "/domains/strict.com"),
      json(owner, "PATCH", { require_sso: true }),
    );

    expect(required.status).toBe(200);
    expect(await required.json()).toMatchObject({ require_sso: true });

    // Her session is gone; someone of another domain keeps theirs.
    resetStandingCaches();
    expect((await signedIn(atDomain)).status).toBe(401);
    expect((await signedIn(other)).status).toBe(200);

    // The provider cannot be removed while a domain requires it.
    const removal = await call(sso("strict-org", "/provider"), json(owner, "DELETE"));
    expect(removal.status).toBe(409);
    expect(await removal.json()).toMatchObject({ error: "sso_required" });
  });
});
