// The signatures of toolkits' credential types (#206), against published test vectors: OAuth 1.0a's signature base
// string and HMAC-SHA1 signatures (RFC 5849 §3.4.1.1 and §1.2, and Twitter's documented example), and HMAC-SHA256 on the
// same base string (NetSuite's token-based auth); AWS SigV4 (cases of the AWS Signature Version 4 test suite, as
// awslabs/aws-c-auth publishes it: `tests/aws-signing-test-suite/v4`); JWTs signed with HMAC (jwt.io's example) and
// with RSA, RSA-PSS and ECDSA keys in each PEM form, checked with the public key by Node.js's own crypto.
import { Buffer } from "node:buffer";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { type JwtAlgorithm, JwtKeyError, signJwt } from "../../src/signing/jwt.ts";
import { oauth1Authorization, signatureBaseString } from "../../src/signing/oauth1.ts";
import {
  amzDateOf,
  canonicalRequest,
  sigV4Authorization,
  sigV4Url,
} from "../../src/signing/sigv4.ts";
import { renderTemplate, templateFields } from "../../src/signing/template.ts";

/** The parameters of an OAuth `Authorization` header, decoded. */
const oauthParams = (header: string): Record<string, string> => {
  expect(header.startsWith("OAuth ")).toBe(true);

  return Object.fromEntries(
    header
      .slice("OAuth ".length)
      .split(", ")
      .map((part) => {
        const [name = "", quoted = ""] = part.split("=");

        return [name, decodeURIComponent(quoted.slice(1, -1))];
      }),
  );
};

/** RFC 5849 §1.2: the photos example's keys. */
const PHOTOS = {
  consumerKey: "dpf43f3p2l4k3l03",
  consumerSecret: "kd94hf93k423kf44",
  token: "nnch734d00sl2jdk",
  tokenSecret: "pfkkdhi9sl3r4s00",
} as const;

describe("OAuth 1.0a", () => {
  it("builds RFC 5849's signature base string (§3.4.1.1)", () => {
    expect(
      signatureBaseString(
        "POST",
        "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b",
        [
          ["c2", ""],
          ["a3", "2 q"],
        ],
        {
          oauth_consumer_key: "9djdj82h48djs9d2",
          oauth_token: "kkk9d7dh3k39sjv7",
          oauth_signature_method: "HMAC-SHA1",
          oauth_timestamp: "137131201",
          oauth_nonce: "7d8f3e4a",
        },
      ),
    ).toBe(
      "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7",
    );
  });

  it("signs RFC 5849's photos request with HMAC-SHA1 (§1.2)", () => {
    const header = oauth1Authorization(
      { method: "GET", url: "http://photos.example.net/photos?file=vacation.jpg&size=original" },
      { ...PHOTOS, signatureMethod: "HMAC-SHA1" },
      { nonce: "chapoH", timestamp: 137131202 },
    );

    expect(oauthParams(header)).toEqual({
      oauth_consumer_key: "dpf43f3p2l4k3l03",
      oauth_token: "nnch734d00sl2jdk",
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: "137131202",
      oauth_nonce: "chapoH",
      oauth_signature: "MdpQcU8iPSUjWoN/UDMsK2sui9I=",
    });
  });

  it("signs the same request with HMAC-SHA256, and names the realm unsigned", () => {
    const header = oauth1Authorization(
      { method: "GET", url: "http://photos.example.net/photos?file=vacation.jpg&size=original" },
      { ...PHOTOS, signatureMethod: "HMAC-SHA256", realm: "1234567_SB1" },
      { nonce: "chapoH", timestamp: 137131202 },
    );

    expect(header.startsWith('OAuth realm="1234567_SB1", ')).toBe(true);
    expect(oauthParams(header)).toMatchObject({
      oauth_signature_method: "HMAC-SHA256",
      oauth_signature: "HtMwoX2zenlFjgGg/SNEoKEQmL7CzxYFEKzs7er044Y=",
    });
  });

  it("signs Twitter's documented example, its form body included", () => {
    const header = oauth1Authorization(
      {
        method: "POST",
        url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
        form: [["status", "Hello Ladies + Gentlemen, a signed OAuth request!"]],
      },
      {
        consumerKey: "xvz1evFS4wEEPTGEFPHBog",
        consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
        signatureMethod: "HMAC-SHA1",
      },
      {
        nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
        timestamp: 1318622958,
        extra: { oauth_version: "1.0" },
      },
    );

    expect(oauthParams(header)).toMatchObject({
      oauth_version: "1.0",
      oauth_signature: "hCtSmYh+iHYCEqBWrE7C7hYmtUk=",
    });
  });
});

/** The test suite's keys, region and service, and its time (2015-08-30T12:36:00Z). */
const SUITE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
} as const;

const SUITE_DATE = amzDateOf(Date.UTC(2015, 7, 30, 12, 36, 0));

/** The SHA-256 of an empty payload. */
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const authorization = (signedHeaders: string, signature: string) =>
  `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`;

describe("AWS SigV4", () => {
  it("writes the request's time as the suite does", () => {
    expect(SUITE_DATE).toBe("20150830T123600Z");
  });

  it.each([
    {
      name: "get-vanilla",
      method: "GET",
      target: "/",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    },
    {
      name: "get-vanilla-query-order-key-case",
      method: "GET",
      target: "/?Param2=value2&Param1=value1",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    },
    {
      name: "get-relative-normalized",
      method: "GET",
      target: "/example/..",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    },
    {
      name: "get-relative-relative-normalized",
      method: "GET",
      target: "/example1/example2/../..",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    },
    {
      name: "get-slash-normalized",
      method: "GET",
      target: "//",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    },
    {
      name: "get-slash-dot-slash-normalized",
      method: "GET",
      target: "/./",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    },
    {
      name: "get-slash-pointless-dot-normalized",
      method: "GET",
      target: "/./example",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "ef75d96142cf21edca26f06005da7988e4f8dc83a165a80865db7089db637ec5",
    },
    {
      name: "get-slashes-normalized",
      method: "GET",
      target: "//example//",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "9a624bd73a37c9a373b5312afbebe7a714a789de108f0bdfe846570885f57e84",
    },
    {
      name: "get-space-normalized",
      method: "GET",
      target: "/example space/",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741",
    },
    {
      name: "get-unreserved",
      method: "GET",
      target: "/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f",
    },
    {
      name: "get-utf8",
      method: "GET",
      target: "/\u1234",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85",
    },
    {
      name: "get-vanilla-query-order-encoded",
      method: "GET",
      target: "/?Param-3=Value3&Param=Value2&%E1%88%B4=Value1",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac",
    },
    {
      name: "get-vanilla-query-unreserved",
      method: "GET",
      target:
        "/?-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197",
    },
    {
      name: "get-vanilla-utf8-query",
      method: "GET",
      target: "/?\u1234=bar",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04",
    },
    {
      name: "post-vanilla-query",
      method: "POST",
      target: "/?Param1=value1",
      headers: {},
      payloadHash: EMPTY,
      signed: "host;x-amz-date",
      signature: "28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11",
    },
    {
      name: "get-vanilla-with-session-token",
      method: "GET",
      target: "/",
      headers: {
        "X-Amz-Security-Token": "6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267",
      },
      payloadHash: EMPTY,
      signed: "host;x-amz-date;x-amz-security-token",
      signature: "07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8",
    },
    {
      name: "post-x-www-form-urlencoded",
      method: "POST",
      target: "/",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": "13",
        "x-amz-content-sha256": "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
      },
      payloadHash: "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
      signed: "content-length;content-type;host;x-amz-content-sha256;x-amz-date",
      signature: "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
    },
  ])("signs $name", ({ method, target, headers, payloadHash, signed, signature }) => {
    const at = target.indexOf("?");

    expect(
      sigV4Authorization(
        {
          method,
          path: at === -1 ? target : target.slice(0, at),
          query: at === -1 ? "" : target.slice(at + 1),
          headers: { Host: "example.amazonaws.com", "X-Amz-Date": SUITE_DATE, ...headers },
          payloadHash,
        },
        SUITE,
        SUITE_DATE,
      ),
    ).toBe(authorization(signed, signature));
  });

  it("sends a path and query percent-encoded as RFC 3986 says, a query's space as %20 and plus as %2B", () => {
    expect(
      sigV4Url("https://example.amazonaws.com/a:b/c%20d/e%3Af/?q=a+b%2Bc&r=x*y&s").toString(),
    ).toBe("https://example.amazonaws.com/a%3Ab/c%20d/e%3Af/?q=a%20b%2Bc&r=x%2Ay&s=");
  });

  it("signs a path sent encoded once encoded twice, but S3's as it is sent", () => {
    const uri = (path: string, service: string) =>
      canonicalRequest(
        { method: "GET", path, query: "", headers: {}, payloadHash: EMPTY },
        service,
      ).canonical.split("\n")[1];

    const sent = sigV4Url("https://example.amazonaws.com/documents and settings/a:b").pathname;

    expect(sent).toBe("/documents%20and%20settings/a%3Ab");
    expect(uri(sent, "service")).toBe("/documents%2520and%2520settings/a%253Ab");
    expect(uri(sent, "s3")).toBe(sent);
    expect(uri("//a//b/./c/../", "s3")).toBe("//a//b/./c/../");
  });
});

/** Node.js's check of a JWS with `publicKey`. */
const verified = (token: string, algorithm: JwtAlgorithm, publicKey: string): boolean => {
  const [header = "", payload = "", signature = ""] = token.split(".");
  const hash = `sha${algorithm.slice(2)}`;
  const key = createPublicKey(publicKey);
  const data = Buffer.from(`${header}.${payload}`);
  const bytes = Buffer.from(signature, "base64url");

  if (algorithm.startsWith("ES"))
    return verify(hash, data, { key, dsaEncoding: "ieee-p1363" }, bytes);

  if (algorithm.startsWith("PS"))
    return verify(
      hash,
      data,
      { key, padding: 6, saltLength: Number(algorithm.slice(2)) / 8 },
      bytes,
    );

  return verify(hash, data, key, bytes);
};

const pem = { type: "spki", format: "pem" } as const;

describe("compound templates", () => {
  const fields = { account_id: "acme/eu", token: "t0k" };

  it("fills a header's template with the credential's fields", () => {
    expect(renderTemplate("Bearer {token}", fields)).toEqual({ ok: true, value: "Bearer t0k" });
  });

  it("percent-encodes fields where it is asked to, so a field cannot change a URL's host", () => {
    expect(
      renderTemplate("https://{account_id}.example.com/api", fields, encodeURIComponent),
    ).toEqual({
      ok: true,
      value: "https://acme%2Feu.example.com/api",
    });
  });

  it("names a field the credential lacks", () => {
    expect(renderTemplate("{account_id}:{secret}", fields)).toEqual({
      ok: false,
      missing: "secret",
    });
  });

  it("lists the fields a template names", () => {
    expect(templateFields("{a}-{b}.{a}")).toEqual(["a", "b"]);
  });
});

/** The header of a JWS, decoded. */
const headerOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString());

describe("JWTs", () => {
  it.effect("signs jwt.io's HS256 example", () =>
    Effect.gen(function* () {
      const signed = yield* signJwt(
        "HS256",
        "your-256-bit-secret",
        {},
        { sub: "1234567890", name: "John Doe", iat: 1516239022 },
      );

      expect(signed).toBe(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      );
    }),
  );

  it.effect.each([
    ["RS256", "pkcs8"],
    ["RS512", "pkcs1"],
    ["PS256", "pkcs8"],
  ] as const)("signs %s with an RSA key in %s PEM", ([algorithm, type]) =>
    Effect.gen(function* () {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type, format: "pem" },
        publicKeyEncoding: pem,
      });

      const signed = yield* signJwt(algorithm, privateKey, {}, { iss: "app" });

      expect(verified(signed, algorithm, publicKey)).toBe(true);
      expect(headerOf(signed)).toEqual({ alg: algorithm, typ: "JWT" });
    }),
  );

  it.effect.each([
    ["ES256", "prime256v1", "sec1"],
    ["ES384", "secp384r1", "pkcs8"],
  ] as const)("signs %s with an EC key in %s PEM", ([algorithm, namedCurve, type]) =>
    Effect.gen(function* () {
      const { privateKey, publicKey } = generateKeyPairSync("ec", {
        namedCurve,
        privateKeyEncoding: { type, format: "pem" },
        publicKeyEncoding: pem,
      });

      const signed = yield* signJwt(algorithm, privateKey, {}, { iss: "app" });

      expect(verified(signed, algorithm, publicKey)).toBe(true);
    }),
  );

  it.effect("names the key's id in the header", () =>
    Effect.gen(function* () {
      const signed = yield* signJwt("HS256", "secret", { kid: "k1" }, {});

      expect(headerOf(signed)).toEqual({ alg: "HS256", typ: "JWT", kid: "k1" });
    }),
  );

  it.effect("refuses a key that is not one of the algorithm's", () =>
    Effect.gen(function* () {
      const { privateKey } = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: pem,
      });

      for (const [algorithm, key] of [
        ["RS256", privateKey],
        ["ES256", "not a key"],
        ["HS256", ""],
      ] as const) {
        const signed = yield* signJwt(algorithm, key, {}, {}).pipe(Effect.flip);

        expect(signed).toBeInstanceOf(JwtKeyError);
      }
    }),
  );
});
