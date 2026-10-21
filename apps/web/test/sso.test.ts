import { describe, expect, it } from "vitest";
import type { SsoDomainView, SsoProviderView, SsoSettings } from "@commissary/contract/sso";
import { needsWorkEmail, signInProblem } from "../src/lib/sign-in.ts";
import { pageAllowed, pagesFor, callerOf } from "../src/lib/role.ts";
import {
  canChangeSso,
  domainProblem,
  domainStatus,
  draftOf,
  normalizeDomain,
  providerFacts,
  providerPayload,
  providerProblems,
  removeProviderBlock,
  requireBlock,
  secretStored,
  serviceProviderFacts,
  sortDomains,
  ssoProblem,
  workEmailProblem,
  workSignInProblem,
} from "../src/lib/sso.ts";

const oidc: SsoProviderView = {
  kind: "oidc",
  issuer: "https://login.acme.com",
  client_id: "proxy",
  authorization_endpoint: "https://login.acme.com/authorize",
  token_endpoint: "https://login.acme.com/token",
  updated_at: "2026-10-12T10:00:00Z",
  updated_by: "ada@acme.com",
};

const saml: SsoProviderView = {
  kind: "saml",
  entry_point: "https://idp.acme.com/sso",
  idp_entity_id: "https://idp.acme.com/entity",
  certificate_expires_at: "2027-10-12T10:00:00Z",
  updated_at: "2026-10-12T10:00:00Z",
  updated_by: "ada@acme.com",
};

const domain = (
  name: string,
  verified: boolean,
  requireSso = false,
  stamped = verified,
): SsoDomainView => ({
  domain: name,
  verified,
  require_sso: requireSso,
  record: {
    name: `_commissary-challenge.${name}`,
    value: "commissary-domain-verification=abc",
  },
  ...(stamped && { verified_at: "2026-10-13T09:00:00Z" }),
});

const service: SsoSettings["service_provider"] = {
  oidc_redirect_uri: "https://proxy.example/api/auth/sso/callback/sso-org",
  saml_acs_url: "https://proxy.example/api/auth/sso/saml2/sp/acs/sso-org",
  saml_entity_id: "https://proxy.example/api/auth/sso/saml2/sp/metadata?providerId=sso-org",
  saml_metadata_url: "https://proxy.example/api/auth/sso/saml2/sp/metadata?providerId=sso-org",
};

const navLinks = (hosted: boolean) =>
  pagesFor("admin", { privateCredentials: false, hosted }).map((page) => page.to);

describe("who may change single sign-on", () => {
  it("is for org owners, and platform admins who own every org", () => {
    expect(canChangeSso(callerOf({ role: "owner", platform_admin: false }))).toBe(true);
    expect(canChangeSso(callerOf({ role: null, platform_admin: true }))).toBe(true);
    expect(canChangeSso(callerOf({ role: "admin", platform_admin: false }))).toBe(false);
    expect(canChangeSso(callerOf({ role: "member", platform_admin: false }))).toBe(false);
  });

  it("puts the page in the nav of org admins on Commissary Cloud only", () => {
    expect(navLinks(true)).toContain("/settings/sso");
    expect(navLinks(false)).not.toContain("/settings/sso");
    expect(
      pagesFor("member", { privateCredentials: true, hosted: true }).map((page) => page.to),
    ).not.toContain("/settings/sso");
    expect(pageAllowed("member", "/settings/sso")).toBe(false);
    expect(pageAllowed("admin", "/settings/sso")).toBe(true);
  });
});

describe("the provider form", () => {
  it("starts empty for OpenID Connect, and from a saved provider's public fields", () => {
    expect(draftOf(null)).toMatchObject({ kind: "oidc", issuer: "", clientSecret: "" });

    expect(draftOf(oidc)).toMatchObject({
      kind: "oidc",
      issuer: "https://login.acme.com",
      clientId: "proxy",
      clientSecret: "",
    });

    expect(draftOf(saml)).toMatchObject({
      kind: "saml",
      entryPoint: "https://idp.acme.com/sso",
      idpEntityId: "https://idp.acme.com/entity",
      certificate: "",
    });
  });

  it("asks a new OpenID Connect provider for its secret, and lets a saved one keep it", () => {
    const draft = { ...draftOf(null), issuer: "https://login.acme.com", clientId: "proxy" };

    expect(providerProblems(draft, null)).toEqual({
      clientSecret: "Enter the client secret the provider gave you.",
    });

    expect(providerProblems(draft, oidc)).toEqual({});
    expect(providerProblems(draft, saml)).toHaveProperty("clientSecret");
    expect(secretStored(oidc)).toBe(true);
    expect(secretStored(saml)).toBe(false);
    expect(secretStored(null)).toBe(false);
  });

  it("checks the issuer and the client ID", () => {
    expect(Object.keys(providerProblems(draftOf(null), oidc)).toSorted()).toEqual([
      "clientId",
      "issuer",
    ]);

    const http = { ...draftOf(oidc), issuer: "http://login.acme.com" };

    expect(providerProblems(http, oidc).issuer).toContain("https");
    expect(providerProblems({ ...http, issuer: "login.acme.com" }, oidc).issuer).toContain("https");

    expect(
      providerProblems({ ...http, issuer: "https://user:pw@login.acme.com" }, oidc).issuer,
    ).toContain("https");
  });

  it("checks a SAML provider's sign-in URL, entity ID and certificate", () => {
    const draft = { ...draftOf(saml), kind: "saml" as const };

    expect(providerProblems(draft, saml)).toEqual({
      certificate: "Paste the certificate the provider signs with.",
    });

    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

    expect(providerProblems({ ...draft, certificate: pem }, saml)).toEqual({});
    expect(providerProblems({ ...draft, certificate: "MIIBabc+/=\nxyz" }, saml)).toEqual({});
    expect(providerProblems({ ...draft, certificate: "not a cert!" }, saml)).toHaveProperty(
      "certificate",
    );

    expect(
      Object.keys(providerProblems({ ...draftOf(null), kind: "saml" }, null)).toSorted(),
    ).toEqual(["certificate", "entryPoint", "idpEntityId"]);
  });

  it("builds a trimmed payload, and sends no secret when none was typed", () => {
    const draft = {
      ...draftOf(null),
      issuer: " https://login.acme.com ",
      clientId: " proxy ",
      clientSecret: "  ",
    };

    expect(providerPayload(draft)).toEqual({
      kind: "oidc",
      issuer: "https://login.acme.com",
      client_id: "proxy",
    });

    expect(providerPayload({ ...draft, clientSecret: " s3cret " })).toEqual({
      kind: "oidc",
      issuer: "https://login.acme.com",
      client_id: "proxy",
      client_secret: "s3cret",
    });

    expect(
      providerPayload({
        ...draftOf(null),
        kind: "saml",
        entryPoint: "https://idp.acme.com/sso ",
        idpEntityId: " https://idp.acme.com/entity",
        certificate: "\nMIIB\n",
      }),
    ).toEqual({
      kind: "saml",
      entry_point: "https://idp.acme.com/sso",
      idp_entity_id: "https://idp.acme.com/entity",
      certificate: "MIIB",
    });
  });

  it("says a saved OpenID Connect provider's secret is stored, and never shows one", () => {
    const facts = providerFacts(oidc);

    expect(facts.find((fact) => fact.label === "Client secret")?.value).toContain("Stored");
    expect(JSON.stringify(facts)).not.toContain("s3cret");
    expect(facts.find((fact) => fact.label === "Issuer")?.value).toBe("https://login.acme.com");
    expect(facts.at(-1)?.value).toContain("ada@acme.com");
    expect(providerFacts(saml).find((fact) => fact.label === "Certificate")?.value).toContain(
      "Expires",
    );
  });

  it("lists what the identity provider is told, by protocol", () => {
    expect(serviceProviderFacts(service, "oidc")).toEqual([
      { label: "Redirect URI", value: service.oidc_redirect_uri },
    ]);

    expect(serviceProviderFacts(service, "saml").map((fact) => fact.value)).toEqual([
      service.saml_acs_url,
      service.saml_entity_id,
      service.saml_metadata_url,
    ]);
  });

  it("holds the provider while a domain requires single sign-on", () => {
    expect(removeProviderBlock([domain("acme.com", true)])).toBeUndefined();

    expect(removeProviderBlock([domain("acme.com", true, true), domain("acme.org", true)])).toBe(
      "acme.com requires single sign-on. Turn that off first.",
    );
  });
});

describe("domains", () => {
  it("normalizes a typed domain like the server", () => {
    expect(normalizeDomain(" Acme.COM. ")).toBe("acme.com");
    expect(normalizeDomain("mail.acme.co.uk")).toBe("mail.acme.co.uk");
    expect(normalizeDomain("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");

    for (const text of ["", "acme", "-a.com", "a..com", "*.acme.com", "192.168.0.1", "a b.com"])
      expect(normalizeDomain(text)).toBeUndefined();
    expect(normalizeDomain(`${"a".repeat(64)}.com`)).toBeUndefined();
  });

  it("explains what is wrong with a typed domain", () => {
    expect(domainProblem("acme.com")).toBeUndefined();
    expect(domainProblem("")).toContain("Enter a domain");
    expect(domainProblem("ada@acme.com")).toContain("not an email");
    expect(domainProblem("https://acme.com/login")).toContain("without https://");
    expect(domainProblem("acme")).toContain("not a domain name");
  });

  it("says where a domain stands", () => {
    expect(domainStatus(domain("acme.com", false))).toBe("Not verified yet");
    expect(domainStatus(domain("acme.com", true))).toMatch(/^Verified /);
    expect(domainStatus(domain("acme.com", true, false, false))).toBe("Verified");
  });

  it("allows requiring single sign-on for a verified domain with a provider", () => {
    expect(requireBlock(domain("acme.com", false), oidc)).toBe("Verify the domain first.");
    expect(requireBlock(domain("acme.com", true), null)).toBe("Set an identity provider first.");
    expect(requireBlock(domain("acme.com", true), oidc)).toBeUndefined();
    // Already required: it can always be switched off.
    expect(requireBlock(domain("acme.com", true, true), null)).toBeUndefined();
  });

  it("lists verified domains first, then by name", () => {
    expect(
      sortDomains([domain("z.com", true), domain("b.com", false), domain("a.com", true)]).map(
        (entry) => entry.domain,
      ),
    ).toEqual(["a.com", "z.com", "b.com"]);
  });
});

describe("a refused single sign-on write", () => {
  it("has words for each of the server's codes", () => {
    expect(ssoProblem("owner_required", "x")).toContain("org owner");
    expect(ssoProblem("management_key_forbidden", "x")).toContain("management key");
    expect(ssoProblem("sso_required", "x")).toContain("Turn that off");
    expect(ssoProblem("record_not_found", "x")).toContain("TXT record");
    expect(ssoProblem("dns_unavailable", "x")).toContain("DNS lookup failed");
    expect(ssoProblem("domain_taken", "x")).toContain("Another org");
    expect(ssoProblem("domain_exists", "x")).toContain("already");
    expect(ssoProblem("too_many_domains", "x")).toContain("20");
    expect(ssoProblem("domain_unverified", "x")).toContain("Verify the domain");
    expect(ssoProblem("provider_missing", "x")).toContain("No identity provider");
    expect(ssoProblem("client_secret_required", "x")).toContain("client secret");
  });

  it("adds the server's explanation to a provider it refused", () => {
    expect(
      ssoProblem("discovery_failed", "x", "the issuer's discovery document could not be used: 404"),
    ).toBe(
      "The issuer’s discovery document could not be used. The issuer's discovery document could not be used: 404.",
    );

    expect(ssoProblem("invalid_provider", "x", "the certificate has expired")).toBe(
      "The provider’s settings were refused. The certificate has expired.",
    );

    expect(ssoProblem("provider_unreachable", "x", "the provider publishes no signing keys")).toBe(
      "The provider publishes no signing keys.",
    );

    expect(ssoProblem("invalid_provider", "x")).toContain("Check each field");
  });

  it("falls back to the server's explanation, then the message", () => {
    expect(ssoProblem("surprise", "Surprise.", "something odd")).toBe("Something odd.");
    expect(ssoProblem("surprise", "Surprise.")).toBe("Surprise.");
    expect(ssoProblem(undefined, "The server did not answer.")).toBe("The server did not answer.");
  });
});

describe("signing in with a work email", () => {
  it("checks the typed email", () => {
    expect(workEmailProblem("ada@acme.com")).toBeUndefined();
    expect(workEmailProblem(" Ada@Acme.com ")).toBeUndefined();
    expect(workEmailProblem("")).toBeDefined();
    expect(workEmailProblem("ada")).toBeDefined();
  });

  it("says no org signs in an email's domain on 404 sso_not_found", () => {
    expect(workSignInProblem(404, "sso_not_found")).toContain("No organization");
    expect(workSignInProblem(404, undefined)).toBe("Could not start the sign-in. Try again.");
    expect(workSignInProblem(403, undefined)).toContain("bot check");
    expect(workSignInProblem(429, undefined)).toContain("Too many");
  });

  it("steers a refused GitHub or Google sign-in to the work email form", () => {
    expect(needsWorkEmail("sso_required")).toBe(true);
    expect(needsWorkEmail(" SSO_REQUIRED ")).toBe(true);
    expect(needsWorkEmail("sso_removed")).toBe(false);
    expect(needsWorkEmail("access_denied")).toBe(false);
    expect(needsWorkEmail(null)).toBe(false);
  });

  it("explains each refusal code of Better Auth's redirect", () => {
    expect(signInProblem("sso_required")).toBe(
      "Your organization requires you to sign in with your work email. Enter it below.",
    );

    expect(signInProblem("sso_removed")).toContain("removed you");
    expect(signInProblem("sso_domain_unverified")).toContain("verified");
    expect(signInProblem("sso_unavailable")).toContain("not available");

    // An unknown code still gets the general line.
    expect(signInProblem("sso_new_code")).toContain("Sign-in failed");
  });
});
