// Signing in through an org's identity provider on the auth host (issue #76; src/sign-in/, src/http/sign-in-routes.ts):
// people of a domain the org verified sign in through it (OIDC or SAML) and become members; GitHub and Google are
// refused for a domain that requires single sign-on. The org's domains and provider are set straight through the state
// Worker's objects (the routes that set them up are the app Worker's, apps/app/test/hosted/sso.test.ts); the identity
// providers and Google are fakes behind the global `fetch`.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { resetStandingCaches } from "@commissary/auth";
import { type IdpSettings, serviceProviderOf } from "@commissary/auth/sso";
import type { OrgId } from "@commissary/core";
import { controlPlaneOf, platformOf } from "@commissary/state";
import {
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  OIDC_ISSUER,
  oidcIssuer,
  oidcState,
  SAML_CERTIFICATE,
  SAML_ENTITY_ID,
  SAML_SSO_URL,
  samlAnswer,
} from "./identity-providers.ts";
import {
  addMember,
  APP_ORIGIN,
  AUTH_ORIGIN,
  call,
  clearPeople,
  cookiesOf,
  finishSignIn,
  fromApp,
  GOOD_TURNSTILE,
  installFakes,
  membersOf,
  orgOwnedBy,
  orgsOf,
  restoreFetch,
  sessionOf,
  signIn,
  startSignIn,
  startSocial,
  upstreams,
} from "./support.ts";

/** The person Google signs in next. */
let googleEmail = "";

const base64url = (json: string) =>
  btoa(json).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** Google's token endpoint: an ID token for {@link googleEmail} (Better Auth reads it without checking a signature). */
const google = (request: Request): Response | undefined => {
  if (request.url !== "https://oauth2.googleapis.com/token") return undefined;

  const claims = {
    iss: "https://accounts.google.com",
    sub: `google-${googleEmail}`,
    email: googleEmail,
    email_verified: true,
    name: googleEmail,
  };

  return Response.json({
    access_token: "ya29.test",
    token_type: "Bearer",
    expires_in: 3600,
    id_token: `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}.signature`,
  });
};

beforeAll(async () => {
  await installFakes();
  const fakes = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    return google(request) ?? (await oidcIssuer(request)) ?? (await fakes(request));
  };
});

afterAll(restoreFetch);

beforeEach(async () => {
  await clearPeople();
  resetStandingCaches();
  upstreams.unexpected = [];
  oidcState.tokenRequests = [];
});

const OIDC: IdpSettings = {
  kind: "oidc",
  issuer: OIDC_ISSUER,
  clientId: OIDC_CLIENT_ID,
  clientSecret: OIDC_CLIENT_SECRET,
  authorizationEndpoint: `${OIDC_ISSUER}/authorize`,
  tokenEndpoint: `${OIDC_ISSUER}/token`,
  jwksEndpoint: `${OIDC_ISSUER}/jwks`,
};

/** Verifies `domain` for `org` as the app Worker's SSO routes do once its TXT record is found. */
const verifyDomain = async (org: OrgId, domain: string): Promise<void> => {
  const plane = controlPlaneOf(env, org);

  expect((await plane.addSsoDomain(domain, Date.now())).ok).toBe(true);
  expect((await platformOf(env).claimSsoDomain(domain, org)).ok).toBe(true);
  expect((await plane.markSsoDomainVerified(domain, Date.now())).ok).toBe(true);
};

/** Sets `settings` as the org's identity provider, as `PUT /sso/provider` stores it. */
const setProvider = async (org: OrgId, settings: IdpSettings, by: string): Promise<void> => {
  expect((await controlPlaneOf(env, org).setSsoProvider(settings, by, Date.now())).ok).toBe(true);
};

/** Requires single sign-on for `domain` of `org`, as `PATCH /sso/domains/:domain` records it. */
const requireSso = async (org: OrgId, domain: string): Promise<void> => {
  expect((await controlPlaneOf(env, org).setSsoDomainRequired(domain, true)).ok).toBe(true);
  expect(await platformOf(env).setSsoDomainRequired(domain, org, true)).toBe(true);
};

/** An org `slug` with `domain` verified and the fake OIDC issuer as its provider. */
const oidcOrg = async (slug: string, domain: string): Promise<OrgId> => {
  const owner = `owner-${slug}@example.com`;
  const org = await orgOwnedBy(slug, owner);

  await verifyDomain(org, domain);
  await setProvider(org, OIDC, owner);

  return org;
};

/** Starts a sign-in with a work email the way the sign-in page does. */
const startSso = (email: string, turnstile: string | null = GOOD_TURNSTILE) =>
  call("/api/auth/sign-in/sso", {
    method: "POST",
    headers: fromApp(turnstile === null ? {} : { "x-captcha-response": turnstile }),
    body: JSON.stringify({ email }),
  });

/** Signs `email` in through Google; the callback's response. */
const googleSignIn = async (email: string): Promise<Response> => {
  const start = await startSocial("google");

  expect(start.status).toBe(200);
  googleEmail = email;

  return await finishSignIn(start, "google");
};

/** Signs `email` in through the fake OIDC issuer; the callback's response. */
const oidcSignIn = async (email: string): Promise<Response> => {
  const start = await startSso(email);
  expect(start.status).toBe(200);
  const { url } = await start.json<{ url: string }>();
  const authorize = new URL(url);

  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${OIDC_ISSUER}/authorize`);
  expect(authorize.searchParams.get("login_hint")).toBe(email);
  oidcState.email = email;
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");

  // The identity provider sends the browser back to the auth host.
  expect(callback.origin).toBe(AUTH_ORIGIN);

  return await call(
    `${callback.pathname}?code=code-1&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`,
    { headers: { cookie: cookiesOf(start), "sec-fetch-site": "cross-site" } },
  );
};

/**
 * Where a refused sign-in sends the browser: a page on the app host (the sign-in page, unless the sign-in's own request
 * is gone), with the reason.
 */
const refusal = (response: Response, page = "/sign-in"): string | null => {
  expect(response.status).toBe(302);
  expect(cookiesOf(response)).not.toContain("session_token");
  const location = new URL(response.headers.get("location") ?? "", AUTH_ORIGIN);

  expect(`${location.origin}${location.pathname}`).toBe(`${APP_ORIGIN}${page}`);

  return location.searchParams.get("error");
};

describe("signing in with an org's identity provider", () => {
  it("signs a person in through OIDC and makes them a member of the org", async () => {
    const org = await oidcOrg("oidc-org", "oidc-corp.com");
    const callback = await oidcSignIn("olga@oidc-corp.com");

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${APP_ORIGIN}/`);
    const cookie = cookiesOf(callback);

    expect(cookie).toContain("session_token");
    expect(await sessionOf(cookie)).toMatchObject({ email: "olga@oidc-corp.com" });
    // Admitted before the session started, so the sign-up gave them no Personal org.
    expect(await orgsOf("olga@oidc-corp.com")).toEqual(["oidc-org"]);
    expect(await membersOf(org)).toContainEqual(
      expect.objectContaining({ email: "olga@oidc-corp.com", role: "member" }),
    );

    // Commissary authenticated as the org's client, with PKCE.
    expect(oidcState.tokenRequests[0]?.get("code_verifier")).toBeTruthy();
  });

  it("signs a person in through SAML and makes them a member of the org", async () => {
    const owner = "owner-saml-org@example.com";
    const org = await orgOwnedBy("saml-org", owner);

    await verifyDomain(org, "saml-corp.com");
    await setProvider(
      org,
      {
        kind: "saml",
        entryPoint: SAML_SSO_URL,
        idpEntityId: SAML_ENTITY_ID,
        certificate: SAML_CERTIFICATE,
      },
      owner,
    );

    // What the org owner tells the identity provider (the app Worker shows it, on the auth host).
    const sp = serviceProviderOf(AUTH_ORIGIN, org);

    const start = await startSso("sam@saml-corp.com");
    expect(start.status).toBe(200);
    const { url } = await start.json<{ url: string }>();
    expect(url.startsWith(`${SAML_SSO_URL}?`)).toBe(true);

    const answer = await samlAnswer(
      url,
      { entityId: sp.samlEntityId, acsUrl: sp.samlAcsUrl },
      "sam@saml-corp.com",
    );

    // The identity provider's page posts the answer from its own site.
    const post = () =>
      call(new URL(sp.samlAcsUrl).pathname, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: new URL(SAML_SSO_URL).origin,
          "sec-fetch-site": "cross-site",
        },
        body: new URLSearchParams(answer).toString(),
      });

    const acs = await post();

    expect(acs.status).toBe(302);
    const cookie = cookiesOf(acs);
    expect(cookie).toContain("session_token");
    expect(await sessionOf(cookie)).toMatchObject({ email: "sam@saml-corp.com" });
    expect(await membersOf(org)).toContainEqual(
      expect.objectContaining({ email: "sam@saml-corp.com", role: "member" }),
    );

    // The same answer cannot be posted twice; its request is gone, so the browser goes back to the panel.
    expect(refusal(await post(), "/")).toBe("invalid_saml_response");
  });

  it("keeps the role of someone who already was a member", async () => {
    const org = await oidcOrg("member-org", "member-corp.com");

    await addMember(org, "ada@member-corp.com", "admin");

    expect((await oidcSignIn("ada@member-corp.com")).headers.get("location")).toBe(
      `${APP_ORIGIN}/`,
    );
    expect(await membersOf(org)).toContainEqual(
      expect.objectContaining({ email: "ada@member-corp.com", role: "admin" }),
    );
  });

  it("takes a work email only with a solved bot check", async () => {
    await oidcOrg("bot-org", "bot-corp.com");

    expect((await startSso("bea@bot-corp.com", null)).status).toBe(403);
  });

  it("does not redirect for a domain no org verified", async () => {
    const owner = "owner-pending-org@example.com";
    const org = await orgOwnedBy("pending-org", owner);

    expect((await controlPlaneOf(env, org).addSsoDomain("pending.com", Date.now())).ok).toBe(true);
    await setProvider(org, OIDC, owner);

    for (const email of ["pat@pending.com", "nobody@unknown-corp.com", "not an email"]) {
      const start = await startSso(email);

      expect(start.status).toBe(404);
      expect(await start.json()).toMatchObject({ error: "sso_not_found" });
    }
  });

  it("does not let an org's provider sign in an email of another domain", async () => {
    await oidcOrg("narrow-org", "narrow.com");
    const callback = await oidcSignIn("olga@narrow.com");
    expect(callback.status).toBe(302);

    // The issuer answers with someone of a domain the org has not verified.
    const start = await startSso("eve@narrow.com");
    const { url } = await start.json<{ url: string }>();
    const authorize = new URL(url);
    oidcState.email = "eve@elsewhere.com";
    const callbackUrl = new URL(authorize.searchParams.get("redirect_uri") ?? "");

    const response = await call(
      `${callbackUrl.pathname}?code=code-2&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`,
      { headers: { cookie: cookiesOf(start), "sec-fetch-site": "cross-site" } },
    );

    expect(refusal(response)).toBe("sso_domain_unverified");
  });

  it("does not add back someone an org admin removed, until they are added again", async () => {
    const org = await oidcOrg("removal-org", "removal.com");
    expect((await oidcSignIn("rita@removal.com")).status).toBe(302);

    const rita = (await membersOf(org)).find((member) => member.email === "rita@removal.com");
    const owner = { role: "owner", sensitive: true } as const;

    expect((await controlPlaneOf(env, org).removeMember(rita?.id ?? "", owner)).ok).toBe(true);

    resetStandingCaches();
    expect(refusal(await oidcSignIn("rita@removal.com"))).toBe("sso_removed");
    expect((await membersOf(org)).map((member) => member.email)).not.toContain("rita@removal.com");

    await addMember(org, "rita@removal.com", "member");

    const again = await oidcSignIn("rita@removal.com");
    expect(again.status).toBe(302);
    expect(cookiesOf(again)).toContain("session_token");
  });
});

describe("requiring single sign-on", () => {
  it("refuses GitHub and Google for the domain, and still signs its people in through the identity provider", async () => {
    const org = await oidcOrg("strict-org", "strict.com");

    // Before: GitHub works for the domain.
    expect(await signIn({ email: "gina@strict.com" })).toContain("session_token");

    await requireSso(org, "strict.com");

    // GitHub and Google are refused for the domain now; the identity provider still signs her in.
    expect(await signIn({ email: "gina@strict.com" })).toBe("");
    expect(await signIn({ email: "gina@example.com" })).toContain("session_token");
    expect(refusal(await googleSignIn("gina@strict.com"))).toBe("sso_required");
    expect(cookiesOf(await googleSignIn("gina@example.com"))).toContain("session_token");
    expect((await oidcSignIn("gina@strict.com")).headers.get("location")).toBe(`${APP_ORIGIN}/`);
  });

  it("says why GitHub was refused", async () => {
    const org = await oidcOrg("why-org", "why.com");

    await requireSso(org, "why.com");

    upstreams.person = { email: "walt@why.com" };
    const callback = await finishSignIn(await startSignIn());

    expect(refusal(callback)).toBe("sso_required");
  });
});
