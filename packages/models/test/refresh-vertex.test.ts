// Vertex service-account JWT minting: PEM repair, PKCS#1 -> PKCS#8, RS256 signing, token cache.
import { Effect } from "effect";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  mintVertexToken,
  pkcs1ToPkcs8,
  privateKeyToPkcs8,
  serviceAccountOf,
  VertexTokenCache,
} from "../src/credentials/refresh/vertex.ts";
import { mockHttp, routes, T0 } from "./support/refresh.ts";
import {
  makeServiceAccount,
  verifyJwt,
  wrapPem,
  type TestServiceAccount,
} from "./support/vertex.ts";

let sa: TestServiceAccount;

beforeAll(async () => {
  sa = await makeServiceAccount();
});

const TOKEN = "POST https://oauth2.googleapis.com/token";

describe("private key handling", () => {
  it("wraps PKCS#1 into the same PKCS#8 WebCrypto exports", () => {
    expect(pkcs1ToPkcs8(sa.pkcs1)).toEqual(sa.pkcs8);
  });

  it("accepts PKCS#8 and PKCS#1 PEM, CRLF, ANSI noise and single-line bodies", () => {
    expect(privateKeyToPkcs8(sa.pem.pkcs8)).toEqual(sa.pkcs8);
    expect(privateKeyToPkcs8(sa.pem.pkcs1)).toEqual(sa.pkcs8);
    expect(privateKeyToPkcs8(sa.pem.pkcs1.replace(/\n/g, "\r\n"))).toEqual(sa.pkcs8);
    expect(privateKeyToPkcs8(`\u001b[31m${sa.pem.pkcs8}\u001b[0m`)).toEqual(sa.pkcs8);
    expect(privateKeyToPkcs8(wrapPem("RSA PRIVATE KEY", sa.pkcs1, 0))).toEqual(sa.pkcs8);
    expect(privateKeyToPkcs8("not a key")).toBeUndefined();
    expect(
      privateKeyToPkcs8("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----"),
    ).toBeUndefined();
  });

  it("reads the service account from the nested object", () => {
    expect(serviceAccountOf({ service_account: sa.account(sa.pem.pkcs8) })).toMatchObject({
      clientEmail: "sa@proj-1.iam.gserviceaccount.com",
      privateKeyId: "kid-1",
      tokenUri: "https://oauth2.googleapis.com/token",
    });
    expect(serviceAccountOf({ service_account: { client_email: "x" } })).toBeUndefined();
  });
});

const mint = (
  metadata: Record<string, unknown>,
  handler = routes({ [TOKEN]: { body: { access_token: "ya29.token", expires_in: 3599 } } }),
) => {
  const http = mockHttp(handler);

  const result = Effect.runPromise(
    mintVertexToken(metadata as never, T0).pipe(
      Effect.provide(http.layer),
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    ),
  );

  return { http, result };
};

describe("mintVertexToken", () => {
  it.each([
    ["PKCS#8 PEM", () => sa.pem.pkcs8],
    ["PKCS#1 PEM", () => sa.pem.pkcs1],
  ])("signs an RS256 assertion from a %s key and exchanges it", async (_name, key) => {
    const { http, result } = mint({ type: "vertex", service_account: sa.account(key()) });
    const outcome = await result;
    expect(outcome).toMatchObject({
      ok: true,
      value: { accessToken: "ya29.token", expiresAt: T0 + 3_599_000 },
    });

    const form = http.requests[0]?.form() ?? {};
    expect(form.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const jwt = await verifyJwt(form.assertion as string, sa.publicKey);
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    const iat = Math.floor(T0 / 1000);
    expect(jwt.claims).toEqual({
      iss: "sa@proj-1.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    });
  });

  it("fails cleanly for a broken key, a non-https token_uri and an error response", async () => {
    const broken = await mint({ service_account: sa.account("garbage") }).result;
    expect(broken).toMatchObject({ ok: false });
    expect(JSON.stringify(broken)).not.toContain("garbage");

    const insecure = await mint({
      service_account: sa.account(sa.pem.pkcs8, { token_uri: "http://x/token" }),
    }).result;

    expect(insecure).toMatchObject({ ok: false });

    const denied = await mint(
      { service_account: sa.account(sa.pem.pkcs8) },
      routes({ [TOKEN]: { status: 400, body: '{"error":"invalid_grant"}' } }),
    ).result;

    expect(denied).toMatchObject({ ok: false, error: { status: 400 } });
  });
});

describe("outbound guard on token_uri", () => {
  it.each([
    "http://oauth2.example.com/token",
    "https://169.254.169.254/token",
    "https://10.0.0.1/token",
    "https://[fd00::1]/token",
  ])("refuses the token_uri %s without sending the assertion", async (tokenUri) => {
    const { http, result } = mint({
      service_account: sa.account(sa.pem.pkcs8, { token_uri: tokenUri }),
    });

    const outcome = await result;

    expect(outcome).toMatchObject({ ok: false });
    expect(JSON.stringify(outcome)).toContain(OUTBOUND_REFUSED_MESSAGE);
    expect(http.requests).toEqual([]);
  });
});

describe("VertexTokenCache", () => {
  it("serves a token until exp - 60 s and is keyed by the credential fingerprint", () => {
    const cache = new VertexTokenCache();
    const token = { accessToken: "t", expiresAt: T0 + 3_600_000 };
    cache.set("v.json", "1:10", token);
    expect(cache.get("v.json", "1:10", T0)).toBe(token);
    expect(cache.get("v.json", "1:10", T0 + 3_600_000 - 60_001)).toBe(token);
    expect(cache.get("v.json", "1:10", T0 + 3_600_000 - 60_000)).toBeUndefined();
    expect(cache.get("v.json", "1:11", T0)).toBeUndefined();
    expect(cache.get("other.json", "1:10", T0)).toBeUndefined();
    cache.delete("v.json");
    expect(cache.get("v.json", "1:10", T0)).toBeUndefined();
  });
});
