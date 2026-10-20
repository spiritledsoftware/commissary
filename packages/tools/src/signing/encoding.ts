/**
 * Encodings and digests the request signatures of toolkits' credential types share (#206): RFC 3986 percent-encoding
 * (OAuth 1.0a's and AWS SigV4's), HMAC and SHA-256 through `node:crypto`, which is synchronous (WebCrypto's are not),
 * so a request is signed where it is built, and base64url (JWTs).
 */
import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";

/** `value` percent-encoded as RFC 3986 says: every byte but the unreserved characters (`A-Za-z0-9-._~`). */
export const percentEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** Byte order of two strings of ASCII (percent-encoded ones). */
export const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Decoded `parameters` percent-encoded, sorted by name then value and joined (`a=1&b=2`): OAuth 1.0a's normalized
 * parameters (RFC 5849 §3.4.1.3.2) and SigV4's canonical query.
 */
export const sortedParameters = (parameters: ReadonlyArray<readonly [string, string]>): string =>
  parameters
    .map(([name, value]) => [percentEncode(name), percentEncode(value)] as const)
    .toSorted(
      ([nameA, valueA], [nameB, valueB]) => byteOrder(nameA, nameB) || byteOrder(valueA, valueB),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

export type HmacHash = "sha1" | "sha256";

/** The HMAC of `data` under `key`. */
export const hmac = (hash: HmacHash, key: string | Uint8Array, data: string): Buffer =>
  createHmac(hash, key).update(data, "utf8").digest();

/** The SHA-256 of `data`, hex. */
export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** `bytes` (or a string's UTF-8) as base64url without padding (RFC 7515 §2). */
export const base64Url = (bytes: string | Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");
