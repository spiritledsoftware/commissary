/**
 * JWTs signed from a stored key (#206), with WebCrypto (in workerd as in Node.js): RSA (`RS*`, RSASSA-PKCS1-v1_5),
 * RSA-PSS (`PS*`), ECDSA (`ES256`, `ES384`) and HMAC (`HS*`) signatures (RFC 7518 §3). A private key is PEM: PKCS#8
 * (`BEGIN PRIVATE KEY`, a Google service account's), PKCS#1 for RSA (`BEGIN RSA PRIVATE KEY`, a GitHub App's) or SEC1 for
 * EC (`BEGIN EC PRIVATE KEY`), the last two wrapped into PKCS#8 for WebCrypto; an HMAC key is the secret's UTF-8 bytes.
 * A JWS's ECDSA signature is the raw `r || s`, which is what WebCrypto answers.
 */
import { Buffer } from "node:buffer";
import { Effect, Schema } from "effect";
import type { JwtAlgorithm } from "@commissary/contract/tools";
import { base64Url } from "./encoding.ts";

export type { JwtAlgorithm };

/** The key cannot sign with the algorithm: it is not a key of its kind, or not PEM. */
export class JwtKeyError extends Schema.TaggedError<JwtKeyError>()("JwtKeyError", {
  message: Schema.String,
}) {}

/** The SHA-2 hash of `algorithm`: every algorithm's name ends in its size (`RS256`). */
const hashOf = (algorithm: JwtAlgorithm): string => `SHA-${algorithm.slice(2)}`;

type ImportParams = Parameters<typeof crypto.subtle.importKey>[2];

type SignParams = Parameters<typeof crypto.subtle.sign>[0];

/** The curve of an ECDSA `algorithm`: its WebCrypto name and its DER OID. */
const CURVES = new Map([
  ["ES256", { name: "P-256", oid: "06082a8648ce3d030107" }],
  ["ES384", { name: "P-384", oid: "06052b81040022" }],
]);

/** The DER length octets of `length`. */
const derLength = (length: number): Uint8Array => {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: Array<number> = [];

  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);

  return Uint8Array.of(0x80 | bytes.length, ...bytes);
};

/** A DER element of `tag` holding `parts`. */
const der = (tag: number, ...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const body = Buffer.concat(parts);

  return Buffer.concat([Uint8Array.of(tag), derLength(body.length), body]);
};

const hex = (text: string): Uint8Array => Buffer.from(text, "hex");

/** PKCS#8's `PrivateKeyInfo` around a key of `algorithm` (its DER `AlgorithmIdentifier` contents). */
const pkcs8Of = (algorithmIdentifier: Uint8Array, key: Uint8Array): Uint8Array =>
  der(0x30, hex("020100"), der(0x30, algorithmIdentifier), der(0x04, key));

/** rsaEncryption with NULL parameters. */
const RSA_ENCRYPTION = hex("06092a864886f70d0101010500");

/** id-ecPublicKey. */
const EC_PUBLIC_KEY = hex("06072a8648ce3d0201");

const PEM = /^-----BEGIN ([A-Z ]+)-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END \1-----\s*$/;

/** The PKCS#8 DER of a PEM private key for `algorithm`, if it is one of its forms. */
const pkcs8Der = (algorithm: JwtAlgorithm, key: string): Uint8Array | undefined => {
  const match = PEM.exec(key.trim().replace(/\r/g, ""));

  if (match === null) return undefined;
  const [, label, body = ""] = match;
  const bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");

  if (label === "PRIVATE KEY") return bytes;

  if (label === "RSA PRIVATE KEY" && !algorithm.startsWith("ES"))
    return pkcs8Of(RSA_ENCRYPTION, bytes);
  const curve = CURVES.get(algorithm);

  if (label === "EC PRIVATE KEY" && curve !== undefined)
    return pkcs8Of(Buffer.concat([EC_PUBLIC_KEY, hex(curve.oid)]), bytes);

  return undefined;
};

/** WebCrypto's names of `algorithm`: how its key is imported, and how it signs. */
const webCryptoOf = (algorithm: JwtAlgorithm) => {
  const hash = hashOf(algorithm);

  switch (algorithm.slice(0, 2)) {
    case "RS":
      return {
        key: { name: "RSASSA-PKCS1-v1_5", hash } satisfies ImportParams,
        sign: "RSASSA-PKCS1-v1_5" satisfies SignParams,
      };
    case "PS":
      return {
        key: { name: "RSA-PSS", hash } satisfies ImportParams,
        sign: { name: "RSA-PSS", saltLength: Number(algorithm.slice(2)) / 8 } satisfies SignParams,
      };
    case "ES":
      return {
        key: {
          name: "ECDSA",
          namedCurve: CURVES.get(algorithm)?.name ?? "P-256",
        } satisfies ImportParams,
        sign: { name: "ECDSA", hash } satisfies SignParams,
      };
    default:
      return {
        key: { name: "HMAC", hash } satisfies ImportParams,
        sign: "HMAC" satisfies SignParams,
      };
  }
};

const keyError = (algorithm: JwtAlgorithm) =>
  new JwtKeyError({
    message: algorithm.startsWith("HS")
      ? "the JWT's key is empty"
      : `the private key is not a PEM ${algorithm.startsWith("ES") ? "EC" : "RSA"} key for ${algorithm}`,
  });

/** `key` imported to sign as `algorithm`, or why it cannot. */
export const importSigningKey = (
  algorithm: JwtAlgorithm,
  key: string,
): Effect.Effect<CryptoKey, JwtKeyError> => {
  const params = webCryptoOf(algorithm).key;

  if (algorithm.startsWith("HS"))
    return key === ""
      ? Effect.fail(keyError(algorithm))
      : Effect.tryPromise({
          try: () =>
            crypto.subtle.importKey("raw", new TextEncoder().encode(key), params, false, ["sign"]),
          catch: () => keyError(algorithm),
        });

  const bytes = pkcs8Der(algorithm, key);

  if (bytes === undefined) return Effect.fail(keyError(algorithm));

  return Effect.tryPromise({
    try: () => crypto.subtle.importKey("pkcs8", bytes, params, false, ["sign"]),
    catch: () => keyError(algorithm),
  });
};

/** A JWT of `claims` signed with `key` as `algorithm`; its header names the key's id when given (`kid`). */
export const signJwt = Effect.fnUntraced(function* (
  algorithm: JwtAlgorithm,
  key: string,
  header: { readonly kid?: string | undefined },
  claims: Schema.JsonObject,
): Effect.fn.Return<string, JwtKeyError> {
  const signingKey = yield* importSigningKey(algorithm, key);

  const input = [
    base64Url(
      JSON.stringify({
        alg: algorithm,
        typ: "JWT",
        ...(header.kid === undefined ? {} : { kid: header.kid }),
      }),
    ),
    base64Url(JSON.stringify(claims)),
  ].join(".");

  const signature = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.sign(webCryptoOf(algorithm).sign, signingKey, new TextEncoder().encode(input)),
    catch: () => keyError(algorithm),
  });

  return `${input}.${base64Url(new Uint8Array(signature))}`;
});
